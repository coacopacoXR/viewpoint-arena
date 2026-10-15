"""Run conversions in subprocesses, CONVERT_CONCURRENCY of them at a time.

This is the parent half of the boundary worker.py explains: the service holds no
OpenCascade, no document and no tessellation in its own address space. What it
does hold is a queue.

Three rules this module exists to keep:

  * ONE JOB AT A TIME BY DEFAULT. Tessellation needs roughly six times the file
    size in memory, so `CONVERT_CONCURRENCY=1` means the container's
    CONVERT_MEM_LIMIT bounds one job rather than being shared by an unknown
    number of them. Extra requests wait on an asyncio.Semaphore instead of
    failing: a queue is what a room full of people opening the same assembly
    needs, and the alternative (429) would make the second participant's import
    fail for a reason they cannot act on.
  * THE DEADLINE COVERS THE QUEUE, NOT ONLY THE WORK. `asyncio.timeout` wraps
    both the wait for a slot and the subprocess, so CONVERT_TIMEOUT_S is a
    promise to the caller about how long a request can take, and a caller can
    never be left waiting behind a slow job for ever.
  * A KILLED JOB TAKES ITS CHILDREN WITH IT. The worker runs gltfpack as its own
    subprocess, so on POSIX the worker is started in a new session and the whole
    GROUP is signalled on timeout. Killing only the worker would leave a
    compressor running against a file whose job no longer exists.

Nothing here logs the uploaded file's name or bytes. OpenCascade prints product
names from the file to stdout while it reads, which is why the subprocess's
stdout and stderr are discarded rather than forwarded to the service log: this
service's rule, like capture-service's, is that neither a response nor a log line
carries content. A developer who needs OCCT's chatter runs
`python -m convert_service.worker --job … --result …` by hand.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import signal
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .config import Settings
from .errors import (
    ConvertCrashed,
    ConvertEmpty,
    ConvertServiceError,
    ConvertTimeout,
    ConvertUnreadable,
    EngineUnavailable,
)

logger = logging.getLogger("convert_service")

#: The GLB's filename inside a job directory. Fixed, and never derived from the
#: upload: the response carries no Content-Disposition, so nothing a client sent
#: is used to name a file on this disk.
OUTPUT_NAME = "model.glb"

#: The worker's result `code` → the error the caller gets. A code that is not in
#: this table is a bug in one of the two halves, and is reported as a crash
#: rather than passed through: an unknown code must not become an unknown
#: response body.
ERROR_BY_CODE: dict[str, type[ConvertServiceError]] = {
    "convert_unreadable": ConvertUnreadable,
    "convert_empty": ConvertEmpty,
    "engine_unavailable": EngineUnavailable,
    "convert_crashed": ConvertCrashed,
}


@dataclass(frozen=True)
class ConversionResult:
    """A finished conversion, as the route reports it.

    `glb_path` is a file inside a temp directory this runner created, and
    `cleanup` removes that directory. The route passes `cleanup` to Starlette as
    a background task so the file outlives the return statement and is deleted
    once the body has actually been sent — streaming from disk rather than
    holding a 100 MB GLB in the service's heap.
    """

    glb_path: Path
    part_count: int
    triangle_count: int
    convert_ms: int
    unique_meshes: int
    node_count: int
    cleanup: Callable[[], None]


class JobRunner(Protocol):
    """What main.py needs of a runner. tests/conftest.py provides a fake."""

    async def run(self, source: Path, *, file_name: str, reader: str) -> ConversionResult:
        ...  # pragma: no cover - protocol


class SubprocessRunner:
    """The production runner: one `convert_service.worker` process per job."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._slots = asyncio.Semaphore(settings.concurrency)
        # Reported by /health so an operator can see a queue building before the
        # timeouts start: everything inside run(), waiting or converting.
        self._in_flight = 0

    @property
    def in_flight(self) -> int:
        return self._in_flight

    async def run(self, source: Path, *, file_name: str, reader: str) -> ConversionResult:
        # mkdtemp rather than a TemporaryDirectory context manager: the GLB has
        # to survive this function, because Starlette streams the response body
        # after the route returns. `cleanup` is what removes it, as a background
        # task; every failure path removes it here instead.
        work = Path(tempfile.mkdtemp(prefix="convert-job-"))
        self._in_flight += 1
        try:
            payload = await self._run_job(work, source, file_name=file_name, reader=reader)
        except BaseException:
            shutil.rmtree(work, ignore_errors=True)
            raise
        finally:
            self._in_flight -= 1

        return ConversionResult(
            glb_path=work / OUTPUT_NAME,
            part_count=int(payload.get("partCount") or 0),
            triangle_count=int(payload.get("triangleCount") or 0),
            convert_ms=int(payload.get("convertMs") or 0),
            unique_meshes=int(payload.get("uniqueMeshes") or 0),
            node_count=int(payload.get("nodeCount") or 0),
            cleanup=lambda: shutil.rmtree(work, ignore_errors=True),
        )

    async def _run_job(
        self, work: Path, source: Path, *, file_name: str, reader: str
    ) -> dict:
        job_path = work / "job.json"
        result_path = work / "result.json"
        destination = work / OUTPUT_NAME
        job_path.write_text(
            json.dumps(
                {
                    "input": str(source),
                    "output": str(destination),
                    "reader": reader,
                    # The client's X-File-Name, so the glTF scene can be named
                    # after the file the way cadResultToGroup names its root
                    # group. Nothing else in the job carries client text.
                    "fileName": file_name,
                    "gltfpack": self._settings.gltfpack,
                }
            ),
            encoding="utf-8",
        )

        try:
            async with asyncio.timeout(self._settings.timeout_seconds):
                # The deadline wraps the wait for a slot as well as the work, so
                # CONVERT_TIMEOUT_S bounds how long a REQUEST takes rather than
                # only how long a conversion may run.
                async with self._slots:
                    return await self._execute(job_path, result_path, destination)
        except TimeoutError:
            # asyncio.timeout cancelled the block, and _execute's handler has
            # already killed the process group by the time this runs.
            raise ConvertTimeout(self._settings.timeout_seconds) from None

    async def _execute(self, job_path: Path, result_path: Path, destination: Path) -> dict:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "convert_service.worker",
            "--job",
            str(job_path),
            "--result",
            str(result_path),
            # Discarded, not piped: OCCT's transfer statistics can quote product
            # names from the uploaded file (see the module docstring), and a pipe
            # nobody drains would also deadlock a chatty job.
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            # A new session puts the worker AND the gltfpack it spawns in their
            # own process group, which is what _kill signals. POSIX only: on
            # Windows the argument is not supported and killing the worker is the
            # best that can be done.
            start_new_session=os.name == "posix",
        )

        try:
            await process.communicate()
        except BaseException:
            # Cancellation (the deadline) or anything else: do not leave a
            # tessellating process behind, then let the exception travel.
            _kill(process)
            with contextlib.suppress(ProcessLookupError, OSError):
                await process.wait()
            raise

        payload = _read_result(result_path)
        if payload is None:
            # A worker that exits without writing a result has crashed before it
            # could report anything, which is the case the subprocess exists for.
            logger.warning(
                "convert-service: the conversion process exited %s with no result",
                process.returncode,
            )
            raise ConvertCrashed(
                f"the conversion process exited {process.returncode} without a result"
            )
        if payload.get("ok") is not True:
            error = _error_from(payload, process.returncode)
            # The DETAIL is logged and never sent: it is this service's own text
            # (a reader status, an exception type, gltfpack's last line) and it
            # is the only record of why a job failed. errors.py bounds its length,
            # and every string that reaches it is built here or in worker.py from
            # fixed vocabulary — none of them interpolates the uploaded name.
            logger.warning("convert-service %s: %s", error.code, error.detail)
            raise error
        if not destination.is_file():
            raise ConvertCrashed("the conversion reported success but wrote no GLB")
        return payload


def _read_result(result_path: Path) -> dict | None:
    """The worker's result JSON, or None if it is missing or unparseable.

    Unparseable counts as missing: a worker OOM-killed mid-write leaves a
    truncated file, and a half-written JSON is the same fact as no JSON.
    """
    try:
        payload = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _error_from(payload: dict, returncode: int | None) -> ConvertServiceError:
    """Turn the worker's failure payload into this service's error type."""
    code = str(payload.get("code") or "")
    detail = str(payload.get("detail") or f"worker exited {returncode}")
    error_class = ERROR_BY_CODE.get(code, ConvertCrashed)
    return error_class(detail)


def _kill(process: asyncio.subprocess.Process) -> None:
    """Kill the job's whole process group, or the process where there is none."""
    if process.returncode is not None:
        return
    if os.name == "posix":
        with contextlib.suppress(ProcessLookupError, OSError):
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        return
    with contextlib.suppress(ProcessLookupError, OSError):
        process.kill()
