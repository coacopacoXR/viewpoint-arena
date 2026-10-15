"""The HTTP surface, tested with a fake runner: no OpenCascade, no subprocess.

Every test here runs on a machine that has never heard of cadquery-ocp, which is
the point of injecting jobs.JobRunner (see conftest.py). What they cover is the
half of this service that is about being a service: the format gate, the
streaming size cap, the error vocabulary, the shared secret, and the three
response headers task 03b codes against.

tests/test_conversion.py covers the other half â€” the actual tessellation â€” and
needs the engine.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from convert_service import formats
from convert_service.auth import AUTH_HEADER, UNAUTHORIZED_BODY
from convert_service.errors import (
    ConvertCrashed,
    ConvertEmpty,
    ConvertTimeout,
    ConvertUnreadable,
    EngineUnavailable,
    UploadTooLarge,
)
from convert_service.gltf import GLB_CONTENT_TYPE
from convert_service.main import (
    CONVERT_MS_HEADER,
    FILE_NAME_HEADER,
    PART_COUNT_HEADER,
    TRIANGLE_COUNT_HEADER,
)
from conftest import FakeRunner, Service  # noqa: F401  (fixtures come from conftest)

SECRET = "0123456789abcdef0123456789abcdef"

# A filename that must never come back in a response or appear in a log line: it
# stands in for the customer's part number, which is what a model file is named.
SENTINEL_NAME = "SENTINEL-acme-secret-project.step"


def test_health_reports_configuration_and_needs_no_engine(client):
    body = client.get("/health").json()

    assert body["status"] == "ok"
    assert body["service"] == "convert-service"
    assert body["version"]
    assert body["formats"] == list(formats.CAD_EXTENSIONS)
    assert body["limits"] == {
        "maxUploadBytes": 200 * 1024 * 1024,
        "timeoutSeconds": 900.0,
        "concurrency": 1,
    }
    # Both keys are present whatever they say: an operator reads them next to a
    # 503 to find out which install step was missed.
    assert set(body["engine"]) == {"ocpFound", "gltfpackPath"}
    assert body["inFlight"] == 0


def test_health_reports_the_configured_limits(make_service):
    bundle = make_service(
        env={
            "CONVERT_MAX_UPLOAD_BYTES": "1024",
            "CONVERT_TIMEOUT_S": "30",
            "CONVERT_CONCURRENCY": "4",
        }
    )

    limits = bundle.client.get("/health").json()["limits"]

    assert limits == {"maxUploadBytes": 1024, "timeoutSeconds": 30.0, "concurrency": 4}


def test_convert_answers_with_the_glb_and_the_three_headers(client):
    response = client.post(
        "/convert",
        content=b"ISO-10303-21; fake step bytes",
        headers={FILE_NAME_HEADER: "bracket.step"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == GLB_CONTENT_TYPE
    assert response.content == b"glTF-fake"
    assert response.headers[PART_COUNT_HEADER] == "3"
    assert response.headers[TRIANGLE_COUNT_HEADER] == "12"
    assert response.headers[CONVERT_MS_HEADER] == "7"
    # No Content-Disposition: the response names no file, so nothing the client
    # sent is reflected back at it.
    assert "content-disposition" not in response.headers


@pytest.mark.parametrize(
    ("file_name", "reader"),
    [
        ("bracket.step", "step"),
        ("bracket.STP", "step"),
        ("legacy.iges", "iges"),
        ("legacy.IGS", "iges"),
        ("shape.brep", "brep"),
        ("shape.brp", "brep"),
        # A Windows browser can send a whole path; only the suffix is looked at.
        ("C:\\models\\bracket.step", "step"),
    ],
)
def test_the_extension_picks_the_reader(service, file_name, reader):
    response = service.post_convert(file_name=file_name)

    assert response.status_code == 200
    assert service.runner.calls[0]["reader"] == reader


def test_the_upload_is_spooled_with_its_own_suffix_and_then_deleted(service):
    response = service.post_convert(file_name="bracket.step")

    assert response.status_code == 200
    call = service.runner.calls[0]
    # The suffix is what OCCT's readers see; the rest of the name is a temp file
    # this service chose, never anything the client sent.
    assert call["suffix"] == ".step"
    assert call["path"].name.startswith("convert-upload-")
    assert call["bytes"] == b"ISO-10303-21;"
    # Deleted whether the conversion succeeded or not: the model is the artefact
    # this service is least allowed to keep.
    assert not call["path"].exists()


@pytest.mark.parametrize(
    "file_name",
    [
        None,  # no X-File-Name at all
        "",
        "bracket",
        "bracket.glb",
        "bracket.stl",
        "bracket.obj",
        "bracket.step.exe",
        "../../etc/passwd",
    ],
)
def test_a_format_this_service_does_not_read_is_415(client, file_name):
    headers = {} if file_name is None else {FILE_NAME_HEADER: file_name}

    response = client.post("/convert", content=b"anything at all", headers=headers)

    assert response.status_code == 415
    body = response.json()
    assert body["error"] == "unsupported_format"
    # The accepted list is server-side data; what the client sent is not echoed.
    assert body["extensions"] == list(formats.CAD_EXTENSIONS)
    # Nothing the client sent comes back, not even the extension it was refused
    # for: the accepted list is server-side data, the request is not.
    if file_name:
        assert file_name not in json.dumps(body)


def test_an_oversized_upload_is_refused_before_it_is_spooled(make_service):
    bundle = make_service(env={"CONVERT_MAX_UPLOAD_BYTES": "32"})

    response = bundle.post_convert(body=b"x" * 33, file_name="big.step")

    assert response.status_code == 413
    assert response.json() == {"error": "upload_too_large", "maxUploadBytes": 32}
    # The declared size is checked first, so no reader ever ran.
    assert bundle.runner.calls == []


def test_an_oversized_chunked_upload_is_refused_while_it_streams(make_service):
    """No Content-Length, so only the streaming counter can catch this one."""
    bundle = make_service(env={"CONVERT_MAX_UPLOAD_BYTES": "32"})

    response = bundle.client.post(
        "/convert",
        content=iter([b"x" * 20, b"y" * 20]),
        headers={FILE_NAME_HEADER: "chunked.step"},
    )

    assert response.status_code == 413
    assert response.json()["maxUploadBytes"] == 32
    assert bundle.runner.calls == []


def test_exactly_the_limit_is_accepted(make_service):
    bundle = make_service(env={"CONVERT_MAX_UPLOAD_BYTES": "32"})

    response = bundle.post_convert(body=b"x" * 32, file_name="edge.step")

    assert response.status_code == 200
    assert len(bundle.runner.calls[0]["bytes"]) == 32


def test_an_empty_body_is_400_not_a_conversion(client):
    response = client.post("/convert", content=b"", headers={FILE_NAME_HEADER: "empty.step"})

    assert response.status_code == 400
    assert response.json() == {"error": "empty_upload"}


@pytest.mark.parametrize(
    ("failure", "status", "code", "extras"),
    [
        (ConvertUnreadable("the reader refused it"), 422, "convert_unreadable", {}),
        (ConvertEmpty("no tessellatable geometry"), 422, "convert_empty", {}),
        (ConvertTimeout(900.0), 504, "convert_timeout", {"timeoutSeconds": 900.0}),
        (ConvertCrashed("the process was killed"), 500, "convert_crashed", {}),
        (EngineUnavailable("gltfpack not found"), 503, "engine_unavailable", {}),
    ],
)
def test_a_failed_conversion_becomes_its_code_and_nothing_else(
    make_service, failure, status, code, extras
):
    bundle = make_service(runner=FakeRunner(failure=failure))

    response = bundle.post_convert(file_name=SENTINEL_NAME)

    assert response.status_code == status
    body = response.json()
    assert body == {"error": code, **extras}
    # The rule from errors.py, checked where it matters: a failure response
    # carries no filename, no path and no detail from inside the kernel.
    assert "SENTINEL" not in json.dumps(body)
    assert failure.message not in json.dumps(body)


def test_a_failed_conversion_still_removes_the_upload(make_service):
    runner = FakeRunner(failure=ConvertUnreadable("nope"))
    bundle = make_service(runner=runner)

    assert bundle.post_convert(file_name="broken.step").status_code == 422
    assert not runner.calls[0]["path"].exists()


def test_an_unhandled_failure_is_a_code_not_a_traceback(make_app):
    class Exploding(FakeRunner):
        async def run(self, source, *, file_name, reader):
            raise RuntimeError(f"secret detail about {file_name}")

    # raise_server_exceptions=False is what a real caller gets: TestClient's
    # default re-raises through the test instead of letting the handler answer.
    with TestClient(
        make_app(runner=Exploding()), raise_server_exceptions=False
    ) as client:
        response = client.post(
            "/convert", content=b"x", headers={FILE_NAME_HEADER: SENTINEL_NAME}
        )

    assert response.status_code == 500
    assert response.json() == {"error": "internal_error"}
    # The exception's own text — which quoted the client's filename — is in the
    # server log and nowhere in the response.
    assert "secret detail" not in response.text
    assert "SENTINEL" not in response.text


def test_an_unknown_route_is_the_same_error_shape(client):
    response = client.get("/nope")

    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


def test_the_openapi_error_documentation_is_present(client):
    schema = client.get("/openapi.json").json()

    documented = schema["paths"]["/convert"]["post"]["responses"]
    for status in ("400", "413", "415", "422", "500", "503", "504"):
        assert status in documented, f"/convert does not document a {status}"


# â”€â”€â”€ The shared secret â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def test_without_a_secret_every_route_is_open(make_service):
    bundle = make_service()

    assert bundle.client.get("/health").status_code == 200
    assert bundle.post_convert().status_code == 200


@pytest.fixture
def secured(make_service) -> Service:
    return make_service(env={"CONVERT_SHARED_SECRET": SECRET})


def test_every_route_needs_the_secret_including_health(secured):
    """One rule with no exemption list, because an exemption list grows."""
    for request in (
        lambda: secured.client.get("/health"),
        lambda: secured.client.get("/openapi.json"),
        lambda: secured.post_convert(),
    ):
        response = request()
        assert response.status_code == 401
        assert response.json() == UNAUTHORIZED_BODY


def test_the_wrong_secret_is_refused_and_not_echoed(secured):
    response = secured.client.get("/health", headers={AUTH_HEADER: "not-the-secret"})

    assert response.status_code == 401
    assert "not-the-secret" not in response.text


def test_the_right_secret_is_accepted_on_both_headers(secured):
    assert secured.client.get("/health", headers={AUTH_HEADER: SECRET}).status_code == 200
    assert (
        secured.client.get("/health", headers={"Authorization": f"Bearer {SECRET}"}).status_code
        == 200
    )
    assert secured.post_convert(headers={AUTH_HEADER: SECRET}).status_code == 200


def test_a_secret_with_stray_whitespace_still_matches(make_service):
    bundle = make_service(env={"CONVERT_SHARED_SECRET": SECRET})

    response = bundle.client.get("/health", headers={AUTH_HEADER: f"{SECRET}\n"})

    assert response.status_code == 200


def test_the_auth_header_name_is_the_one_the_service_documents():
    # Task 03b's api client has to send this exact string. capture-service pins
    # its pair with a TypeScript parity test; the matching test lands with 03b,
    # and this one keeps the Python half from moving underneath it.
    assert AUTH_HEADER == "X-Convert-Token"


def test_an_unusable_secret_refuses_to_start_the_service(monkeypatch):
    """A bad CONVERT_SHARED_SECRET is a sentence, not a traceback.

    This is the module-level app that `uvicorn convert_service.main:app` imports,
    so the operator sees it at start-up — which is the only moment they can do
    something about it.
    """
    from convert_service.main import load_module_app

    monkeypatch.setenv("CONVERT_SHARED_SECRET", "short")

    with pytest.raises(SystemExit) as failure:
        load_module_app()

    assert "CONVERT_SHARED_SECRET" in str(failure.value)
