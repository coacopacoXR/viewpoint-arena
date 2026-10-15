"""Failure taxonomy for convert-service.

Modelled directly on capture-service/capture_service/errors.py, and the two
rules that shape it are the same:

1. `code` is machine-readable and is the ONLY part of a failure that reaches an
   HTTP response body, plus the small non-sensitive extras a subclass opts in to
   via `response_extras()`. Task 03b's api translates these into the app's own
   error vocabulary, so a code is a contract, not a message: rename one and a
   deployed api misreads it.

2. `message` is content-free BY CONSTRUCTION. Nothing here may quote the uploaded
   file's bytes, its name or a path: messages get logged, and a logged traceback
   is a leak. The uploaded FILENAME is client-controlled text and is never echoed
   in a response or a log line — capture-service has the same rule for the same
   reason. Where an operator genuinely needs detail (which reader failed, how far
   a job got) it is bounded, whitespace-flattened and stays in the server log.

Status codes:

    400  the request was empty — nothing to convert
    401  CONVERT_SHARED_SECRET is set and was not presented (auth.py)
    413  over CONVERT_MAX_UPLOAD_BYTES, detected while streaming the body
    415  the file is not a format this service reads
    422  a well-formed request whose file OpenCascade could not use
    500  our own failure, or the conversion subprocess crashed
    503  the engine is not installed
    504  over CONVERT_TIMEOUT_S

The 422/504 pair mirrors what the browser path already tells a person:
cadReadFailureMessage ("Could not read this STEP file…") and cadTimeoutMessage
in utils/cadImport.ts. Task 03b maps them onto those messages so the same file
produces the same sentence whichever side did the work.
"""

from __future__ import annotations

# Cap on any detail repeated into a log line, matching MAX_LOG_EXCERPT in
# capture_service/errors.py.
MAX_LOG_EXCERPT = 300


def excerpt(text: str, limit: int = MAX_LOG_EXCERPT) -> str:
    """Bounded, whitespace-flattened excerpt for a SERVER LOG line only.

    Flattening is not cosmetic: a value containing newlines could otherwise
    forge extra log lines. Never put the result in an HTTP response.
    """
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else f"{flat[:limit]}…"


class ConvertServiceError(Exception):
    """Base class for every failure this service reports on purpose.

    Subclasses set `code` and `status`; `main.create_app` turns any instance
    into a JSON response without ever forwarding `message`.
    """

    code: str = "convert_error"
    status: int = 500

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def response_extras(self) -> dict[str, object]:
        """Non-sensitive additions to the response body. Empty by default."""
        return {}

    def response_body(self) -> dict[str, object]:
        body: dict[str, object] = {"error": self.code}
        body.update(self.response_extras())
        return body


class ConfigError(ConvertServiceError):
    """Environment configuration is unusable. Raised at start-up, not per request."""

    code = "config_invalid"
    status = 500


class UploadTooLarge(ConvertServiceError):
    """The upload exceeded CONVERT_MAX_UPLOAD_BYTES.

    Detected while streaming the body to a temp file, so an oversized assembly is
    refused before a single second of OpenCascade time is spent on it — which
    matters more here than anywhere else in the stack, because the whole point of
    this service is that a 200 MB STEP file is expensive.
    """

    code = "upload_too_large"
    status = 413

    def __init__(self, max_bytes: int) -> None:
        super().__init__(
            f"The uploaded model is larger than the configured limit of "
            f"{max_bytes} bytes (CONVERT_MAX_UPLOAD_BYTES). Split the assembly, "
            f"export it without its history, or raise the limit."
        )
        self.max_bytes = max_bytes

    def response_extras(self) -> dict[str, object]:
        # A number, not content: safe, and it tells the caller the exact ceiling
        # without a second round trip. Same shape as capture-service's 413.
        return {"maxUploadBytes": self.max_bytes}


class EmptyUpload(ConvertServiceError):
    """The request body contained zero bytes."""

    code = "empty_upload"
    status = 400

    def __init__(self) -> None:
        super().__init__("The uploaded model was empty (0 bytes).")


class UnsupportedFormat(ConvertServiceError):
    """The X-File-Name extension is not one this service reads.

    415 rather than 400: the body may be a perfectly good model, it is just not
    a B-rep format OpenCascade can open. The response carries the accepted
    extensions — server-side data, never anything the caller sent — so the api
    can say what to do instead of only what went wrong.
    """

    code = "unsupported_format"
    status = 415

    def __init__(self, extensions: tuple[str, ...]) -> None:
        super().__init__(
            "The file's extension is not one this service tessellates. Send a "
            f"STEP, IGES or BREP file ({', '.join(extensions)}), or a mesh "
            "format the app reads in the browser."
        )
        self.extensions = extensions

    def response_extras(self) -> dict[str, object]:
        return {"extensions": list(self.extensions)}


class ConvertUnreadable(ConvertServiceError):
    """OpenCascade opened the file and found nothing it could use.

    The reader refused the file, or read it and produced no shape at all: a
    corrupt export, a STEP dialect the reader cannot parse, an assembly that
    contains only annotations. 422 because the REQUEST was well-formed — the
    file is the problem, and it is the same situation cadReadFailureMessage
    describes in the browser.
    """

    code = "convert_unreadable"
    status = 422

    def __init__(self, detail: str) -> None:
        super().__init__(
            "OpenCascade could not read this file. If it came from a CAD system, "
            "re-export it as STEP AP214 or AP242."
        )
        # Log-only, and bounded: it names a reader and a status code, never file
        # content.
        self.detail = excerpt(detail)


class ConvertEmpty(ConvertServiceError):
    """The file read fine but tessellated to zero triangles.

    Distinct from ConvertUnreadable because the fix is different: the geometry is
    there and the reader was happy, but every face came back without a
    triangulation (a sheet model with no thickness, or a deflection so coarse
    that nothing survived). Still 422 — the request was well-formed.
    """

    code = "convert_empty"
    status = 422

    def __init__(self, detail: str) -> None:
        super().__init__(
            "This file contains no surfaces OpenCascade could tessellate. "
            "Check that it holds solid or sheet geometry rather than only "
            "annotations, construction curves or empty assemblies."
        )
        self.detail = excerpt(detail)


class ConvertTimeout(ConvertServiceError):
    """The conversion exceeded CONVERT_TIMEOUT_S and its subprocess was killed.

    The subprocess boundary is what makes this recoverable: OpenCascade keeps its
    own state in the killed process, so the service itself is immediately ready
    for the next job rather than holding a half-finished mesh.
    """

    code = "convert_timeout"
    status = 504

    def __init__(self, timeout_seconds: float) -> None:
        super().__init__(
            f"Tessellating this file took longer than {timeout_seconds:g} seconds "
            f"(CONVERT_TIMEOUT_S) and was cancelled. Export a smaller assembly, "
            f"or raise the limit and the container's memory with it."
        )
        self.timeout_seconds = timeout_seconds

    def response_extras(self) -> dict[str, object]:
        return {"timeoutSeconds": self.timeout_seconds}


class ConvertCrashed(ConvertServiceError):
    """The conversion subprocess died without reporting a result.

    A segfault in the kernel, an OOM kill by the container's memory limit, or a
    worker that could not even start. 500 rather than 422: from the caller's
    side nothing was wrong with the request, and the same file may well convert
    on a box with more memory. This is the browser path's cadCrashMessage.
    """

    code = "convert_crashed"
    status = 500

    def __init__(self, detail: str) -> None:
        super().__init__(
            "The conversion process stopped while reading this file. It may have "
            "run out of memory: raise CONVERT_MEM_LIMIT, or export a smaller "
            "assembly."
        )
        self.detail = excerpt(detail)


class EngineUnavailable(ConvertServiceError):
    """OCP or gltfpack is missing, so no conversion can run.

    503, matching capture-service's transcriber_unavailable: the service is up
    and answering, it just cannot do the job it exists for. The message names the
    missing piece and the install step, because the fix is an operator's.
    """

    code = "engine_unavailable"
    status = 503

    def __init__(self, detail: str) -> None:
        super().__init__(
            "The conversion engine is not available in this process. Install "
            "requirements-ocp.txt (cadquery-ocp) and make sure gltfpack is on "
            "PATH — see convert-service/README.md §1."
        )
        self.detail = excerpt(detail)
