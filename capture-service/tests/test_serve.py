"""Start-up paths: `python -m capture_service` and `uvicorn …:app`.

Both are one-liners, and both are what the install script in
docs/local-capture-plan.md §"Installation" will eventually call (T5.1), so the
way they fail matters as much as the way they start.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI

from capture_service import __main__ as serve
from capture_service import main as main_module


def test_the_module_exposes_an_app_for_uvicorn() -> None:
    assert isinstance(main_module.app, FastAPI)
    # The OpenAPI schema rather than app.routes: FastAPI nests an included
    # router instead of copying its routes, so app.routes is not the route list.
    assert set(main_module.app.openapi()["paths"]) == {
        "/health",
        "/capture",
        "/transcribe",
        "/extract",
        "/summarize",
    }


def test_the_module_app_is_built_from_the_process_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPTURE_OLLAMA_MODEL", "llama3.1:8b-instruct")
    assert main_module.load_module_app().state.settings.ollama_model == (
        "llama3.1:8b-instruct"
    )


def test_an_unusable_environment_stops_the_service_before_it_serves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Failing at import is the point: a service that starts and then 503s every
    # request tells an installer nothing about which line of the .env is wrong.
    monkeypatch.setenv("CAPTURE_OLLAMA_BASE_URL", "not-a-url")
    with pytest.raises(SystemExit) as error:
        main_module.load_module_app()
    message = str(error.value)
    assert "CAPTURE_OLLAMA_BASE_URL" in message
    assert "configuration error" in message


def test_serve_binds_the_configured_host_and_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: dict[str, Any] = {}

    def fake_run(target: str, **kwargs: Any) -> None:
        calls["target"] = target
        calls.update(kwargs)

    monkeypatch.setattr(serve.uvicorn, "run", fake_run)
    monkeypatch.setenv("CAPTURE_HOST", "0.0.0.0")
    monkeypatch.setenv("CAPTURE_PORT", "9001")

    assert serve.main() == 0
    assert calls["target"] == "capture_service.main:app"
    assert calls["host"] == "0.0.0.0"
    assert calls["port"] == 9001


def test_serve_defaults_to_localhost_and_the_documented_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: dict[str, Any] = {}
    monkeypatch.setattr(
        serve.uvicorn, "run", lambda target, **kwargs: calls.update(kwargs)
    )
    for name in ("CAPTURE_HOST", "CAPTURE_PORT"):
        monkeypatch.delenv(name, raising=False)

    assert serve.main() == 0
    # 127.0.0.1, not 0.0.0.0: a contributor running this on a laptop should not
    # publish a service that accepts meeting audio to the whole network. A
    # container sets CAPTURE_HOST=0.0.0.0 explicitly.
    assert calls["host"] == "127.0.0.1"
    assert calls["port"] == 8080


def test_serve_reports_a_bad_environment_without_starting(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def refuse(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("the server must not start with an invalid config")

    monkeypatch.setattr(serve.uvicorn, "run", refuse)
    monkeypatch.setenv("CAPTURE_MAX_UPLOAD_BYTES", "lots")

    assert serve.main() == 1
    printed = capsys.readouterr().out
    assert "CAPTURE_MAX_UPLOAD_BYTES" in printed
    assert "configuration error" in printed
