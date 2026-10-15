"""convert-service HTTP surface (task 03a).

    GET  /health    configuration + readiness summary, safe to poll
    POST /convert   a CAD file as the raw request body → the GLB bytes

One route does the work, and it is deliberately not JSON: a STEP file is binary,
the answer is binary, and the counts a caller wants (parts, triangles, how long
it took) travel in headers rather than forcing the api to parse a JSON envelope
around a byte stream it would have to re-serialise anyway. The header names are
the contract task 03b codes against:

    X-Part-Count       nodes in the output that carry a mesh, i.e. parts a
                       participant can select
    X-Triangle-Count   triangles DRAWN, so a shared mesh counts once per instance
    X-Convert-Ms       the whole job: read, tessellate, write and compress

`X-File-Name` on the request decides which OpenCascade reader is used and names
the glTF scene. It is client text, so it is never echoed in a response, never
written to a log line, and never used to name a file on this disk — the upload is
spooled under a temp name whose only client-derived part is a suffix that has to
match `^\\.[a-z0-9]{1,8}$`.

Routes are `async def` here where capture-service uses plain `def`, and the
reason is the work: capture-service blocks a threadpool thread on Whisper, while
this service's work happens in a SUBPROCESS it awaits, so the event loop stays
free to accept, queue and time out the next request. That is what makes
CONVERT_CONCURRENCY=1 safe — one conversion running does not mean one request
being handled.

When CONVERT_SHARED_SECRET is set, every route below — /health and /docs
included — requires it. auth.py explains why there is no exemption list, and why
there is no CORS middleware either.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import re
import shutil
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.background import BackgroundTask
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import FileResponse, JSONResponse

from . import __version__, formats
from .auth import require_shared_secret
from .config import Settings, load_settings
from .errors import (
    ConvertServiceError,
    EmptyUpload,
    UnsupportedFormat,
    UploadTooLarge,
)
from .gltf import GLB_CONTENT_TYPE
from .jobs import JobRunner, SubprocessRunner
from .schemas import EngineHealth, ErrorBody, HealthResponse, LimitsHealth

logger = logging.getLogger("convert_service")

SERVICE_NAME = "convert-service"

#: The header a caller names the file with. Same idea as capture-service's
#: multipart `filename`, but the body here is the file itself.
FILE_NAME_HEADER = "X-File-Name"

#: Response headers carrying the conversion's counts. See the module docstring.
PART_COUNT_HEADER = "X-Part-Count"
TRIANGLE_COUNT_HEADER = "X-Triangle-Count"
CONVERT_MS_HEADER = "X-Convert-Ms"

# Uploads are streamed to a temp file in 1 MiB reads, the chunk size
# capture-service's _spool_upload uses. Streaming (rather than `await
# request.body()`) is what makes CONVERT_MAX_UPLOAD_BYTES enforceable: an
# oversized assembly is abandoned the moment the counter passes the limit,
# instead of being buffered whole into the service's heap and rejected after.
READ_CHUNK_BYTES = 1024 * 1024

# A client-supplied filename is untrusted. Only a short alphanumeric extension
# is ever appended to the temp file name, so no separator or ".." can survive
# into a filesystem path. Same guard, same regex, as capture-service.
_SAFE_SUFFIX = re.compile(r"^\.[a-z0-9]{1,8}$")

_ERROR_MODEL = {"model": ErrorBody, "description": "See convert_service/errors.py."}
ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    400: _ERROR_MODEL,
    413: _ERROR_MODEL,
    415: _ERROR_MODEL,
    422: _ERROR_MODEL,
    500: _ERROR_MODEL,
    503: _ERROR_MODEL,
    504: _ERROR_MODEL,
}

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["convert"])
async def health(request: Request) -> HealthResponse:
    """Configuration and readiness summary.

    Performs no conversion and opens no socket, so it is cheap enough for a
    container healthcheck to poll every 30 s. `ocpFound: false` means "no
    conversion can run", which is worth knowing before the first user hits it;
    it does NOT mean the engine is broken — the Dockerfile proves `import OCP`
    works at build time, because a service that answers 200 to /health and 500 to
    every /convert is worse than one that will not start.
    """
    settings: Settings = request.app.state.settings
    runner: JobRunner = request.app.state.runner

    return HealthResponse(
        status="ok",
        service=SERVICE_NAME,
        version=__version__,
        formats=list(formats.CAD_EXTENSIONS),
        engine=EngineHealth(
            ocp_found=_ocp_found(),
            gltfpack_path=shutil.which(settings.gltfpack),
        ),
        limits=LimitsHealth(
            max_upload_bytes=settings.max_upload_bytes,
            timeout_seconds=settings.timeout_seconds,
            concurrency=settings.concurrency,
        ),
        # Only the production runner keeps a queue; a fake one in the tests has
        # nothing to report and should not have to grow the attribute.
        in_flight=int(getattr(runner, "in_flight", 0)),
    )


@router.post("/convert", responses=ERROR_RESPONSES, tags=["convert"])
async def convert(request: Request) -> FileResponse:
    """Tessellate one CAD file and answer with a meshopt-compressed GLB.

    The body is the file. `Content-Type` on the request is not consulted: the
    extension in X-File-Name picks the reader, and a browser that sends
    `application/octet-stream` for everything is not wrong enough to refuse.
    """
    settings: Settings = request.app.state.settings
    runner: JobRunner = request.app.state.runner

    file_name = request.headers.get(FILE_NAME_HEADER) or ""
    reader = formats.reader_for(file_name)
    if reader is None:
        # Checked BEFORE the body is read: an unsupported file is refused without
        # spooling 200 MB of it to disk first.
        raise UnsupportedFormat(formats.CAD_EXTENSIONS)

    source = await _spool_request_body(
        request, settings.max_upload_bytes, suffix=_safe_suffix(formats.extension_of(file_name))
    )
    try:
        result = await runner.run(source, file_name=file_name, reader=reader)
    finally:
        _remove_quietly(source)

    # Counts and timings, never content: no filename, no path, no part name. The
    # reader is one of three fixed strings by this point, so it is safe to log.
    logger.info(
        "convert: %s, %d part(s), %d triangle(s), %d unique mesh(es), %d ms",
        reader,
        result.part_count,
        result.triangle_count,
        result.unique_meshes,
        result.convert_ms,
    )

    return FileResponse(
        result.glb_path,
        media_type=GLB_CONTENT_TYPE,
        headers={
            PART_COUNT_HEADER: str(result.part_count),
            TRIANGLE_COUNT_HEADER: str(result.triangle_count),
            CONVERT_MS_HEADER: str(result.convert_ms),
        },
        # The GLB lives in the runner's job directory, which must outlive this
        # function because Starlette streams the body after it returns.
        background=BackgroundTask(result.cleanup),
    )


# ─── Upload handling ────────────────────────────────────────────────────────


async def _spool_request_body(request: Request, max_bytes: int, *, suffix: str) -> Path:
    """Stream the request body to a temp file, refusing to exceed `max_bytes`.

    Returns the path; the CALLER owns deletion. This is capture-service's
    `_spool_upload` for a raw body instead of a multipart one, and it keeps both
    of its guarantees:

      * the declared size (Content-Length) is checked first, so an obviously
        oversized upload is rejected before a byte of it is copied anywhere;
      * the streaming counter is the real guarantee, because a chunked request
        has no declared size.
    """
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise UploadTooLarge(max_bytes)

    file_descriptor, raw_path = tempfile.mkstemp(prefix="convert-upload-", suffix=suffix)
    path = Path(raw_path)
    total = 0
    try:
        with os.fdopen(file_descriptor, "wb") as destination:
            # Ownership of the descriptor has passed to the file object; -1 tells
            # the finally block not to close it a second time (a reused descriptor
            # number would close somebody else's file).
            file_descriptor = -1
            async for chunk in request.stream():
                total += len(chunk)
                if total > max_bytes:
                    raise UploadTooLarge(max_bytes)
                destination.write(chunk)
    except BaseException:
        _remove_quietly(path)
        raise
    finally:
        # Only reached with a live descriptor if os.fdopen itself failed.
        if file_descriptor != -1:
            _close_quietly(file_descriptor)

    if total == 0:
        _remove_quietly(path)
        raise EmptyUpload()

    return path


def _safe_suffix(suffix: str) -> str:
    """A temp-file suffix, or nothing. The regex is the path-safety check."""
    return suffix if _SAFE_SUFFIX.match(suffix) else ""


def _remove_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        # A temp file this service cannot delete is worth a log line and nothing
        # more: failing the request over it would hide the real result.
        logger.warning("convert-service: could not remove a temp upload file")


def _close_quietly(file_descriptor: int) -> None:
    try:
        os.close(file_descriptor)
    except OSError:
        pass


def _ocp_found() -> bool:
    """Is the OCP module findable, WITHOUT importing it.

    find_spec locates the package and stops; importing OCP costs seconds and
    hundreds of megabytes, and doing that in the HTTP process would defeat the
    subprocess design this service is built on.
    """
    try:
        return importlib.util.find_spec("OCP") is not None
    except (ImportError, ValueError):
        return False


# ─── App factory ────────────────────────────────────────────────────────────


def create_app(settings: Settings | None = None, runner: JobRunner | None = None) -> FastAPI:
    """Build the FastAPI app.

    The runner is injectable, which is the whole reason the HTTP test suite needs
    no OpenCascade, no gltfpack and no subprocess: tests/conftest.py passes a fake
    that answers from a dict. In production the default is constructed here, and
    note that it touches nothing at construction time — no OCP import, no
    gltfpack probe, no temp directory. The first request pays for all of it, in
    its own process.
    """
    resolved_settings = settings if settings is not None else load_settings()
    resolved_runner = (
        runner if runner is not None else SubprocessRunner(resolved_settings)
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield

    app = FastAPI(
        title="Viewpoint Arena convert-service",
        version=__version__,
        summary=(
            "Local CAD tessellation: a STEP, IGES or BREP file goes in, a "
            "meshopt-compressed GLB with the same assembly tree comes out. "
            "Nothing leaves the network it runs on."
        ),
        lifespan=lifespan,
    )
    app.state.settings = resolved_settings
    app.state.runner = resolved_runner

    _register_error_handlers(app)

    # Registered ONLY when a secret is configured, so an unauthenticated laptop
    # run has the exact request path it always had: no middleware, no per-request
    # header lookup, nothing to disable. See auth.py for why this is opt-in by
    # absence and why it covers every route including /health and /docs.
    if resolved_settings.shared_secret is not None:
        app.middleware("http")(require_shared_secret(resolved_settings.shared_secret))

    app.include_router(router)
    return app


def _register_error_handlers(app: FastAPI) -> None:
    """Turn every failure into a code-only JSON body.

    These handlers are the enforcement point for "no content in an error": the
    message never crosses the wire, whatever raised it.
    """

    @app.exception_handler(ConvertServiceError)
    def _convert_service_error(
        request: Request, exc: ConvertServiceError
    ) -> JSONResponse:
        # The message is content-free by construction (see errors.py), so it is
        # the safe place for operator detail — and the log is the only place it
        # goes.
        logger.warning("convert-service %s: %s", exc.code, exc.message)
        return JSONResponse(status_code=exc.status, content=exc.response_body())

    @app.exception_handler(RequestValidationError)
    def _invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        # exc.errors() carries `input` — the client's own value. Only field
        # LOCATIONS are read, and this service has no validated body models, so
        # this handler exists to keep the error shape predictable if one grows.
        fields = sorted(
            {
                ".".join(str(part) for part in error.get("loc", ())[1:]) or "request"
                for error in exc.errors()
            }
        )
        logger.warning("convert-service invalid_request: %s", ", ".join(fields))
        return JSONResponse(
            status_code=400, content={"error": "invalid_request", "fields": fields}
        )

    @app.exception_handler(StarletteHTTPException)
    def _http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(
            exc.status_code, f"http_{exc.status_code}"
        )
        # exc.detail is dropped: for a framework-raised error it is boilerplate,
        # and this service would rather have one predictable error shape.
        return JSONResponse(
            status_code=exc.status_code, content={"error": code}, headers=exc.headers
        )

    @app.exception_handler(Exception)
    def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        # The traceback goes to the log; the client gets a code. Without this
        # handler an unhandled exception becomes Starlette's bare 500, and the
        # next person to add a raise has to remember what may be quoted in it.
        logger.exception("convert-service unhandled %s", type(exc).__name__)
        return JSONResponse(status_code=500, content={"error": "internal_error"})


def load_module_app() -> FastAPI:
    """Build the module-level app, turning a config error into a clean exit.

    Split out from the assignment below so tests can exercise the failure path
    without re-importing this module (a reload that raises would leave it half
    initialised for everything else in the suite).
    """
    try:
        return create_app()
    except ConvertServiceError as exc:
        # One line naming the variable, instead of a traceback: this runs while
        # uvicorn is importing the module, and the operator needs to know which
        # line of the generated .env to fix.
        raise SystemExit(f"{SERVICE_NAME}: configuration error — {exc.message}") from None


# Importable as `uvicorn convert_service.main:app`.
app = load_module_app()
