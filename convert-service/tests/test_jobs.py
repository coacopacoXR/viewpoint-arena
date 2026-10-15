"""The job runner: queueing, the deadline, and what a worker's failure means.

No engine and no conversion here — these are the guarantees that hold while a
real one is running, which is exactly when they matter. A subprocess is only
started by the last test, and it is `sleep`, not OpenCascade.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from convert_service.config import load_settings
from convert_service.errors import (
    ConvertCrashed,
    ConvertEmpty,
    ConvertTimeout,
    ConvertUnreadable,
    EngineUnavailable,
)
from convert_service.jobs import (
    ERROR_BY_CODE,
    SubprocessRunner,
    _error_from,
    _kill,
    _read_result,
)


def runner_with(**env: str) -> SubprocessRunner:
    return SubprocessRunner(load_settings(dict(env)))


def test_one_conversion_at_a_time_by_default(monkeypatch):
    """CONVERT_CONCURRENCY=1 means the second job waits, not that it fails."""
    runner = runner_with()
    active = 0
    peak = 0
    order: list[str] = []

    async def fake_execute(job_path, result_path, destination):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        # The job file is the only thing that identifies which request this is.
        order.append(json.loads(job_path.read_text())["fileName"])
        await asyncio.sleep(0.02)
        active -= 1
        return {"ok": True}

    monkeypatch.setattr(runner, "_execute", fake_execute)

    async def go():
        return await asyncio.gather(
            *(
                runner.run(Path(os.devnull), file_name=f"part{index}.step", reader="step")
                for index in range(3)
            )
        )

    asyncio.run(go())

    assert peak == 1
    assert order == ["part0.step", "part1.step", "part2.step"]


def test_the_concurrency_setting_is_honoured(monkeypatch):
    runner = runner_with(CONVERT_CONCURRENCY="3")
    active = 0
    peak = 0

    async def fake_execute(job_path, result_path, destination):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.05)
        active -= 1
        return {"ok": True}

    monkeypatch.setattr(runner, "_execute", fake_execute)

    async def go():
        return await asyncio.gather(
            *(
                runner.run(Path(os.devnull), file_name=f"part{index}.step", reader="step")
                for index in range(3)
            )
        )

    asyncio.run(go())

    assert peak == 3


def test_the_deadline_covers_the_queue_not_only_the_work(monkeypatch):
    """A job that waits too long for a slot times out too.

    CONVERT_TIMEOUT_S is a promise to the caller about how long its REQUEST
    takes. If it only bounded the conversion, a queue of large assemblies would
    leave the api hanging on a socket for as long as there were jobs ahead of it.
    """
    runner = runner_with(CONVERT_TIMEOUT_S="1", CONVERT_CONCURRENCY="1")
    started: list[float] = []

    async def slow(job_path, result_path, destination):
        started.append(asyncio.get_running_loop().time())
        await asyncio.sleep(5)
        return {"ok": True}

    monkeypatch.setattr(runner, "_execute", slow)

    async def go():
        return await asyncio.gather(
            *(
                runner.run(Path(os.devnull), file_name="slow.step", reader="step")
                for _ in range(2)
            ),
            return_exceptions=True,
        )

    started_at = time.perf_counter()
    results = asyncio.run(go())
    elapsed = time.perf_counter() - started_at

    # Both were cancelled at the deadline rather than left sleeping out the five
    # seconds the job asked for.
    assert elapsed < 4, f"the deadline did not fire: {elapsed:.2f}s"

    timeouts = [result for result in results if isinstance(result, ConvertTimeout)]
    assert len(timeouts) == 2, results
    assert timeouts[0].timeout_seconds == 1.0
    assert timeouts[0].status == 504


def test_a_worker_that_reports_nothing_is_a_crash(tmp_path):
    result_path = tmp_path / "result.json"

    assert _read_result(result_path) is None

    # Truncated JSON is the same fact as no JSON: an OOM-killed worker leaves one.
    result_path.write_text('{"ok": true, "partCo', encoding="utf-8")
    assert _read_result(result_path) is None

    result_path.write_text(json.dumps({"ok": True}), encoding="utf-8")
    assert _read_result(result_path) == {"ok": True}


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("convert_unreadable", ConvertUnreadable),
        ("convert_empty", ConvertEmpty),
        ("engine_unavailable", EngineUnavailable),
        ("convert_crashed", ConvertCrashed),
        # An unknown code is a bug in one half of the protocol; it must not
        # become an unknown response body.
        ("something_new", ConvertCrashed),
        ("", ConvertCrashed),
    ],
)
def test_a_worker_code_becomes_the_service_error(code, expected):
    error = _error_from({"code": code, "detail": "why"}, returncode=1)

    assert isinstance(error, expected)
    # The detail is kept for the log; the MESSAGE the caller gets is content-free
    # by construction (errors.py), so "why" must not appear in a response body.
    assert error.detail == "why"
    assert "why" not in error.response_body().get("error", "")


def test_every_documented_code_has_a_class():
    """errors.py and jobs.py must not drift apart."""
    from convert_service import errors

    for code in ("convert_unreadable", "convert_empty", "engine_unavailable", "convert_crashed"):
        assert code in ERROR_BY_CODE
        assert ERROR_BY_CODE[code].code == code
    # And the ones the runner raises itself.
    assert errors.ConvertTimeout.code == "convert_timeout"
    assert errors.UploadTooLarge.code == "upload_too_large"


def test_kill_stops_a_real_subprocess():
    """The mechanism the deadline relies on, against a process that will not stop."""

    async def go() -> int:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            "import time; time.sleep(60)",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=os.name == "posix",
        )
        _kill(process)
        return await asyncio.wait_for(process.wait(), timeout=20)

    returncode = asyncio.run(go())

    assert returncode != 0, "the process survived _kill"


def test_the_worker_module_is_runnable_as_a_script(tmp_path):
    """`python -m convert_service.worker --job … --result …` is the whole protocol.

    A job whose input does not exist has to produce a result file rather than a
    traceback: the parent reads the file and turns it into a 500, and a missing
    file is indistinguishable from a segfault.
    """
    job = tmp_path / "job.json"
    result = tmp_path / "result.json"
    job.write_text(
        json.dumps(
            {
                "input": str(tmp_path / "missing.step"),
                "output": str(tmp_path / "model.glb"),
                "reader": "step",
                "fileName": "missing.step",
                "gltfpack": "gltfpack",
            }
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [sys.executable, "-m", "convert_service.worker", "--job", str(job), "--result", str(result)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=Path(__file__).resolve().parents[1],
    )

    assert result.is_file(), completed.stderr
    payload = json.loads(result.read_text(encoding="utf-8"))
    assert payload["ok"] is False
    assert payload["code"] in ERROR_BY_CODE
    assert "convertMs" in payload
    assert completed.returncode == 1
