"""`python -m convert_service.worker` — one conversion, in its own process.

    python -m convert_service.worker --job job.json --result result.json

The HTTP service (convert_service/jobs.py) starts this for every request and
nothing else runs it in production. The reason it is a separate process at all:

  * OpenCascade is native code. A malformed STEP file can segfault the kernel,
    and a segfault in the uvicorn worker takes the service — and every queued
    conversion — down with it. Here it takes down one job, and the parent reports
    `convert_crashed`.
  * Tessellation is memory-hungry: the browser path was measured at roughly six
    times the file size. A job that exceeds the container's limit is OOM-killed
    by the kernel, which again kills this process and not the service.
  * The 67 MB OCP module and its document are released when the process exits,
    rather than accumulating in a long-lived server.

The protocol is a JSON file in and a JSON file out, NOT stdout: OpenCascade
prints its own transfer statistics to stdout while reading a STEP file, so
anything parsed from stdout would have to survive arbitrary native chatter. The
parent discards both streams — see the "no content in a log line" comment in
jobs.py.

Exit codes: 0 the conversion succeeded, 1 it failed and `--result` says why,
2 this process could not even start the job (bad arguments, unreadable job file)
and there is no result to read.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import __version__, formats
from .errors import ConvertCrashed, ConvertServiceError, EngineUnavailable

SERVICE_NAME = "convert-service"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_UNUSABLE = 2

#: What goes into the GLB's asset.generator. A viewer shows this, and it is the
#: fastest way to tell a converted file from one a CAD system exported.
GENERATOR = f"viewpoint-arena convert-service {__version__}"

# gltfpack's own flags. -cc is meshopt compression (EXT_meshopt_compression),
# which the app's GLTFLoader already has a decoder for — modelLoader.ts wires
# MeshoptDecoder precisely so a gltfpack GLB loads.
#
# -kn is MANDATORY and not a size optimisation: without it gltfpack merges nodes
# it considers redundant (measured on tests/fixtures/assembly.step: the "Base
# Plate" group disappears entirely), and merging nodes is merging parts. Per-part
# identity in this app is positional — userData.nodeId is assigned while walking
# the tree — so a merged node silently renumbers every part after it and moves
# every pin. tests/test_conversion.py asserts the names survive compression.
#
# -km keeps material names. No simplification flag is passed: -si would decimate
# geometry, and a design review is about the geometry.
#
# -noq turns OFF gltfpack's default position quantization, and it is the one flag
# here that is a judgement call rather than a requirement. Without it gltfpack
# adds KHR_mesh_quantization and — because a quantized mesh needs its
# dequantisation transform on the node holding it, and one mesh here is held by
# six nodes — inserts an extra UNNAMED node per mesh instance. gltfpack also
# strips every mesh name (in all six flag combinations measured), so GLTFLoader
# has nothing to name the part with and falls back to "mesh_0" and
# "mesh_2_instance_3": that is what the app's model tree would show, and
# collapseSingleChildGroups cannot rescue it, because its placeholder rule only
# matches "Mesh N" / "Group N". With -noq the named node keeps its mesh,
# GLTFLoader names the THREE.Mesh after the node, and the tree matches the
# browser's.
#
# It is not a size regression either: on the fixture, -cc -kn -km is 5832 bytes
# and -cc -kn -km -noq is 5580, because nine extra nodes and their matrices cost
# more than 14-bit positions save. It is also the more accurate choice — 14 bits
# over a 10 m assembly is a 0.6 mm grid, and the browser path this service has to
# match does not quantize at all. README §4 records the measurement.
GLTFPACK_FLAGS = ("-cc", "-kn", "-km", "-noq")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="convert_service.worker")
    parser.add_argument("--job", required=True, help="path to the job JSON")
    parser.add_argument("--result", required=True, help="path to write the result JSON")
    arguments = parser.parse_args(argv)

    try:
        job = json.loads(Path(arguments.job).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        # Nothing to report through: the result path may be the unusable thing.
        print(f"{SERVICE_NAME}: cannot read the job file ({type(exc).__name__})", file=sys.stderr)
        return EXIT_UNUSABLE

    started = time.perf_counter()
    try:
        result = _convert(job)
    except ConvertServiceError as exc:
        # `detail` is the bounded, content-free operator string; `message` is the
        # sentence the caller would see. The parent rebuilds its own error from
        # the code, so only the detail crosses back.
        result = {"ok": False, "code": exc.code, "detail": getattr(exc, "detail", exc.message)}
    except Exception as exc:  # noqa: BLE001 - the parent turns this into a 500
        result = {
            "ok": False,
            "code": "convert_crashed",
            "detail": f"{type(exc).__name__}: {exc}",
        }

    result["convertMs"] = int(round((time.perf_counter() - started) * 1000))
    try:
        _write_result(Path(arguments.result), result)
    except OSError as exc:
        print(f"{SERVICE_NAME}: cannot write the result ({type(exc).__name__})", file=sys.stderr)
        return EXIT_UNUSABLE

    return EXIT_OK if result.get("ok") else EXIT_FAILED


def _write_result(destination: Path, result: dict) -> None:
    """Write the result JSON where the parent will look for it.

    Written to a sibling and renamed into place, so a worker killed mid-write
    (the deadline, or the OOM killer) leaves either the previous file or none —
    never a truncated one the parent might half-parse.
    """
    temporary = destination.with_name(destination.name + ".partial")
    temporary.write_text(json.dumps(result), encoding="utf-8")
    os.replace(temporary, destination)


def _convert(job: dict) -> dict:
    """Read, tessellate, write, compress. Returns the success payload.

    @raises ConvertServiceError with the code the parent should answer with.
    """
    reader = job.get("reader")
    if reader not in formats.READER_LABEL:
        # main.py picks the reader from a fixed table, so an unknown one is a bug
        # in this service rather than anything about the uploaded file.
        raise ConvertCrashed(f"unknown reader {reader!r}")

    # Imported here, not at module scope: the whole point of the subprocess is
    # that OCP is loaded in a process that is allowed to die.
    from . import cad
    from .gltf import write_glb

    source = Path(job["input"])
    destination = Path(job["output"])
    if not source.is_file():
        # The parent spooled this file itself and removes it only after the job,
        # so its absence means the service lost track of its own temp directory.
        raise ConvertCrashed("the spooled upload is gone")

    conversion = cad.convert(
        source,
        reader=reader,
        file_name=job.get("fileName") or "",
    )
    uncompressed = _uncompressed_path(destination)
    written = write_glb(
        conversion.roots,
        uncompressed,
        scene_name=conversion.scene_name,
        generator=GENERATOR,
    )
    compress(uncompressed, destination, gltfpack=job.get("gltfpack") or "")
    # Deleted as soon as it is compressed: on a large assembly the uncompressed
    # GLB is several times the size of the compressed one, and the job directory
    # is on the container's disk.
    uncompressed.unlink(missing_ok=True)

    return {
        "ok": True,
        "reader": conversion.reader,
        "partCount": conversion.part_count,
        "triangleCount": conversion.triangle_count,
        "uniqueMeshes": conversion.unique_meshes,
        "nodeCount": written.node_count,
        "glbBytes": destination.stat().st_size,
        "rawGlbBytes": written.buffer_bytes,
        "compressed": True,
    }


def _uncompressed_path(destination: Path) -> Path:
    """Where the pre-gltfpack GLB goes: a sibling of the output, in the job's dir.

    Not a second temp directory: the parent creates one directory per job and
    removes it when the response has been sent, so everything this worker writes
    has to live inside it. The `.glb` suffix is kept at the END of the name
    because gltfpack decides the input format from it — `model.glb.raw` is
    "unknown extension", and the error says nothing about the real problem.
    """
    return destination.with_name(f"{destination.stem}.raw.glb")


def compress(source: Path, destination: Path, *, gltfpack: str) -> None:
    """Run gltfpack over the uncompressed GLB.

    There is no timeout here on purpose. The parent owns the deadline for the
    whole job (CONVERT_TIMEOUT_S) and kills this process GROUP when it expires,
    which takes gltfpack with it — a second timer here would only race the first.
    """
    executable = shutil.which(gltfpack) if gltfpack else None
    if executable is None:
        raise EngineUnavailable(f"gltfpack not found (looked for {gltfpack!r})")

    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [executable, "-i", str(source), "-o", str(destination), *GLTFPACK_FLAGS],
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0 or not destination.is_file():
        # A conversion whose compression step fails is a 500, not a silently
        # uncompressed GLB: the api (task 03b) budgets for a compressed file when
        # it stores and serves a model, and a broken gltfpack is an install
        # problem an operator has to see.
        stderr = completed.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ConvertCrashed(
            f"gltfpack exited {completed.returncode}"
            + (f": {stderr[-1]}" if stderr else "")
        )


if __name__ == "__main__":
    raise SystemExit(main())
