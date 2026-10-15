"""Wire shapes for the JSON this service answers with.

/convert answers with GLB bytes and three headers, so there is very little here:
the health body and the error body. Both follow capture-service's convention
(capture_service/schemas.py) because task 03b reads them from the same api that
reads capture-service's, and one spelling of `maxUploadBytes` across two services
is one less thing for that code to remember.

Field names go over the wire in camelCase via `WireModel`'s alias generator.
`extra="forbid"` is the guard that stops this service growing a field nobody
agreed to.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


def _to_camel(snake: str) -> str:
    head, *rest = snake.split("_")
    return head + "".join(word[:1].upper() + word[1:] for word in rest)


class WireModel(BaseModel):
    """Base for everything that crosses the HTTP boundary."""

    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
    )


class ErrorBody(WireModel):
    """Every non-2xx body this service returns.

    Documentation of what the exception handlers in main.py emit — the handlers
    build these dicts directly, so a field added here must be added there too.
    The contract with a caller is that `error` is a stable machine-readable code
    (see errors.py) and everything else is optional metadata: never a filename,
    never file content, never a filesystem path.
    """

    error: str
    # Present on upload_too_large.
    max_upload_bytes: int | None = None
    # Present on unsupported_format: the extensions this service does read.
    extensions: list[str] | None = None
    # Present on convert_timeout.
    timeout_seconds: float | None = None


class EngineHealth(BaseModel):
    """Whether the two external pieces this service depends on are reachable.

    Both checks are cheap and read no network: `importlib.util.find_spec` locates
    the OCP module without loading its 67 MB of native code, and `shutil.which`
    stats PATH. Neither proves the engine WORKS — the Dockerfile does that at
    build time, and a job that fails reports `convert_crashed` or
    `engine_unavailable`. Like capture-service's `loaded: false`, a False here
    means "not usable right now", and an operator reads it next to the log.
    """

    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True, frozen=True)

    ocp_found: bool
    gltfpack_path: str | None


class LimitsHealth(BaseModel):
    """The numeric ceilings, so a caller can explain a 413 or a 504 without guessing."""

    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True, frozen=True)

    max_upload_bytes: int
    timeout_seconds: float
    concurrency: int


class HealthResponse(WireModel):
    """Configuration and readiness summary. Safe to poll; performs no I/O."""

    status: str
    service: str
    version: str
    formats: list[str]
    engine: EngineHealth
    limits: LimitsHealth
    # Requests inside the runner right now, waiting for a slot or converting.
    # With CONVERT_CONCURRENCY=1 anything above 1 is a queue.
    in_flight: int
