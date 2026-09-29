"""Environment configuration for capture-service.

Every setting is an environment variable. There is deliberately no settings
file, no settings UI and no command-line flag that overrides these: the plan
(docs/local-capture-plan.md §"Installation") has an install script generate a
`.env`, docker-compose pass it to the container, and a bare-metal systemd unit
read it — one mechanism, three deployments.

All variables use the `CAPTURE_` prefix and NONE of them use a `VITE_` prefix,
because nothing in this service is ever shipped to a browser. That is the rule
enforced by scripts/check-public-env.mjs: a `VITE_` name is inlined into the
client bundle, so a secret in one is a public secret.

Every variable below is a preference EXCEPT `CAPTURE_SHARED_SECRET`, which is a
genuine secret: it is the bearer token that guards a service accepting complete
meeting recordings (see auth.py). It never appears in a response, a log line or
a /health body, and it is generated randomly by install.sh rather than shipped
with a default — a documented default secret is no secret at all.

Variables (all optional; the defaults are the documented local-install values):

    CAPTURE_WHISPER_MODEL         faster-whisper model size or a path to a
                                  CTranslate2 model directory.
                                  Default: base.en
    CAPTURE_WHISPER_DEVICE        auto | cpu | cuda.   Default: cpu
    CAPTURE_WHISPER_COMPUTE_TYPE  default | auto | int8 | int8_float16 |
                                  float16 | float32.   Default: int8
    CAPTURE_WHISPER_LANGUAGE      Language hint for Whisper, e.g. "en".
                                  Empty (the default) means auto-detect.
    CAPTURE_OLLAMA_BASE_URL       Ollama ROOT url, no path — /api/chat is
                                  appended.  Default: http://127.0.0.1:11434
    CAPTURE_OLLAMA_MODEL          Model that must already be pulled on that
                                  Ollama instance.  Default: qwen2.5:7b
    CAPTURE_TIMEOUT_SECONDS       Per-request Ollama timeout.  Default: 600
    CAPTURE_MAX_UPLOAD_BYTES      Hard ceiling on one uploaded recording.
                                  Default: 209715200 (200 MiB)
    CAPTURE_HOST                  Bind address for `python -m capture_service`.
                                  Default: 127.0.0.1
    CAPTURE_PORT                  Bind port for `python -m capture_service`.
                                  Default: 8080
    CAPTURE_SHARED_SECRET         Bearer token required on EVERY route. Empty
                                  (the default) means authentication is off,
                                  which is only safe because the service then
                                  binds 127.0.0.1.  Default: (empty)
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit

from .errors import ConfigError

logger = logging.getLogger("capture_service")

ENV_PREFIX = "CAPTURE_"

# faster-whisper's own `device` and `compute_type` arguments. Allowlists rather
# than free text: a typo here otherwise surfaces as an opaque CTranslate2
# failure on the first request, minutes into a meeting upload.
WHISPER_DEVICES = ("auto", "cpu", "cuda")
WHISPER_COMPUTE_TYPES = (
    "default",
    "auto",
    "int8",
    "int8_float16",
    "float16",
    "float32",
)

# base.en on CPU is the plan's own recommendation for real-time-ish batch use
# (docs/local-capture-plan.md §"faster-whisper server"); small.en is the
# accuracy step up, and a GPU box can take large-v3.
DEFAULT_WHISPER_MODEL = "base.en"

# A localhost default IS correct here, and deliberately differs from
# lib/connectors/capture/ollamaDirect.ts, which refuses to default at all.
# That provider runs in the BROWSER, where "localhost" is whichever machine the
# reviewer happens to be sitting at — a silent default would post a design
# review transcript to a stranger's laptop. This service runs on the org's own
# box, next to the Ollama container it is supposed to talk to.
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"

# The plan's default extraction model: solid output, and CPU-viable in a pinch.
DEFAULT_OLLAMA_MODEL = "qwen2.5:7b"

# Measured with qwen2.5:7b on one short meeting: ~20 s fully on a GPU, and
# over 120 s on a 6 GB laptop GPU whose desktop apps pushed 4 of 29 layers
# onto the CPU (the old 120 s ceiling failed every capture there). CPU-only
# is slower still. 600 s stays inside the 900 s proxy_read_timeout both nginx
# layers give /api/capture/local, leaving room for transcription. Same
# ceiling as the TypeScript Ollama provider (ollamaDirect DEFAULT_TIMEOUT_MS),
# checked by tests/test_typescript_parity.py.
DEFAULT_TIMEOUT_SECONDS = 600.0

# 200 MiB: roughly four hours of Opus/WebM at meeting quality, or under two
# hours of 16-bit mono 16 kHz WAV. Enough for a real design review, small
# enough that one upload cannot exhaust the host's disk.
DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080

# The shortest accepted CAPTURE_SHARED_SECRET. install.sh generates 64 hex
# characters, so this only ever fires on a hand-written value — and a
# hand-written "changeme" guarding a service that accepts meeting recordings is
# worth refusing to start over. Empty is still allowed and means "off".
MIN_SHARED_SECRET_LENGTH = 16

# The complete set of variables this service reads. tests/test_config.py walks
# it, so a variable added to Settings but not to DEFAULTS (or vice versa) fails
# the suite instead of silently becoming unread.
ENV_VAR_NAMES: tuple[str, ...] = (
    "CAPTURE_WHISPER_MODEL",
    "CAPTURE_WHISPER_DEVICE",
    "CAPTURE_WHISPER_COMPUTE_TYPE",
    "CAPTURE_WHISPER_LANGUAGE",
    "CAPTURE_OLLAMA_BASE_URL",
    "CAPTURE_OLLAMA_MODEL",
    "CAPTURE_TIMEOUT_SECONDS",
    "CAPTURE_MAX_UPLOAD_BYTES",
    "CAPTURE_HOST",
    "CAPTURE_PORT",
    "CAPTURE_SHARED_SECRET",
    "CAPTURE_ALLOWED_ORIGINS",
)

DEFAULTS: Mapping[str, str] = {
    "CAPTURE_WHISPER_MODEL": DEFAULT_WHISPER_MODEL,
    "CAPTURE_WHISPER_DEVICE": "cpu",
    "CAPTURE_WHISPER_COMPUTE_TYPE": "int8",
    "CAPTURE_WHISPER_LANGUAGE": "",
    "CAPTURE_OLLAMA_BASE_URL": DEFAULT_OLLAMA_BASE_URL,
    "CAPTURE_OLLAMA_MODEL": DEFAULT_OLLAMA_MODEL,
    "CAPTURE_TIMEOUT_SECONDS": str(int(DEFAULT_TIMEOUT_SECONDS)),
    "CAPTURE_MAX_UPLOAD_BYTES": str(DEFAULT_MAX_UPLOAD_BYTES),
    "CAPTURE_HOST": DEFAULT_HOST,
    "CAPTURE_PORT": str(DEFAULT_PORT),
    # No default secret. Ever. A shipped default would be the first thing an
    # attacker tries, and the service would start happily with it.
    "CAPTURE_SHARED_SECRET": "",
    # No default origins. Empty means no CORS middleware, which is the correct
    # default for a service with no published port.
    "CAPTURE_ALLOWED_ORIGINS": "",
}


@dataclass(frozen=True, slots=True)
class Settings:
    """Validated, immutable service configuration."""

    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    # None means "let Whisper auto-detect".
    whisper_language: str | None
    ollama_base_url: str
    ollama_model: str
    timeout_seconds: float
    max_upload_bytes: int
    host: str
    port: int
    # None means "authentication is off". Declared last with a default so every
    # existing Settings(...) construction — including the one in
    # tests/test_config.py that pins the documented defaults — keeps working.
    shared_secret: str | None = None
    # None means "no CORS middleware". A non-empty list means CORSMiddleware
    # is added with exactly those origins. Parsed by _allowed_origins below.
    allowed_origins: list[str] | None = None


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Read and validate configuration.

    @param env Injectable for tests; defaults to the process environment.
    @raises ConfigError naming the offending variable and what to do about it.
    """
    raw: Mapping[str, str] = os.environ if env is None else env

    # The one variable where empty is a valid setting: it means "let Whisper
    # auto-detect the language", which is the default.
    language = _value(raw, "CAPTURE_WHISPER_LANGUAGE")

    return Settings(
        whisper_model=_text(raw, "CAPTURE_WHISPER_MODEL"),
        whisper_device=_choice(raw, "CAPTURE_WHISPER_DEVICE", WHISPER_DEVICES),
        whisper_compute_type=_choice(
            raw, "CAPTURE_WHISPER_COMPUTE_TYPE", WHISPER_COMPUTE_TYPES
        ),
        whisper_language=language or None,
        ollama_base_url=_url_root(raw, "CAPTURE_OLLAMA_BASE_URL"),
        ollama_model=_text(raw, "CAPTURE_OLLAMA_MODEL"),
        timeout_seconds=_positive_number(raw, "CAPTURE_TIMEOUT_SECONDS"),
        max_upload_bytes=_positive_int(raw, "CAPTURE_MAX_UPLOAD_BYTES"),
        host=_text(raw, "CAPTURE_HOST"),
        port=_port(raw, "CAPTURE_PORT"),
        shared_secret=_shared_secret(raw, "CAPTURE_SHARED_SECRET"),
        allowed_origins=_allowed_origins(raw, "CAPTURE_ALLOWED_ORIGINS"),
    )


# ─── Per-variable validators ────────────────────────────────────────────────
#
# Each one raises a ConfigError that names the variable, shows the value it was
# given and says what a correct value looks like. An IT admin running the
# one-command install sees this once, at start-up, instead of discovering a
# broken value three requests into a meeting.


def _value(raw: Mapping[str, str], name: str) -> str:
    """The variable's value, or its documented default. Whitespace-stripped."""
    return str(raw.get(name, DEFAULTS[name]) or "").strip()


def _text(raw: Mapping[str, str], name: str) -> str:
    value = _value(raw, name)
    if not value:
        raise ConfigError(
            f"{name} must not be empty (default: {DEFAULTS[name]!r}). Set it, "
            f"or unset it entirely to take the default."
        )
    return value


def _choice(raw: Mapping[str, str], name: str, allowed: tuple[str, ...]) -> str:
    value = _value(raw, name)
    if value not in allowed:
        raise ConfigError(
            f"{name} must be one of {', '.join(allowed)} — got {value!r}."
        )
    return value


def _positive_int(raw: Mapping[str, str], name: str) -> int:
    value = _value(raw, name)
    try:
        number = int(value)
    except ValueError:
        raise ConfigError(
            f"{name} must be a whole number of bytes — got {value!r}, which is "
            f"not an integer. No suffixes: write 209715200, not 200MB."
        ) from None
    if number <= 0:
        raise ConfigError(f"{name} must be greater than 0 — got {number}.")
    return number


def _positive_number(raw: Mapping[str, str], name: str) -> float:
    value = _value(raw, name)
    try:
        number = float(value)
    except ValueError:
        raise ConfigError(
            f"{name} must be a number of seconds — got {value!r}."
        ) from None
    # float() accepts 'nan' and 'inf', which would make every request either
    # time out immediately or hang forever.
    if not number == number or number in (float("inf"), float("-inf")):
        raise ConfigError(f"{name} must be a finite number of seconds — got {value!r}.")
    if number <= 0:
        raise ConfigError(f"{name} must be greater than 0 — got {number}.")
    return number


def _port(raw: Mapping[str, str], name: str) -> int:
    number = _positive_int(raw, name)
    if number > 65535:
        raise ConfigError(f"{name} must be between 1 and 65535 — got {number}.")
    return number


def _url_root(raw: Mapping[str, str], name: str) -> str:
    """Validate an Ollama root URL and return it normalised to scheme://host[:port].

    Mirrors normalizeBaseUrl in lib/connectors/capture/ollamaDirect.ts: a
    relative URL, a bare host or a URL carrying a path is rejected rather than
    silently rewritten, because each of those produces a request that goes
    somewhere the operator did not intend.
    """
    value = _value(raw, name)
    parts = urlsplit(value)

    if parts.scheme not in ("http", "https"):
        raise ConfigError(
            f"{name} must be an absolute http or https URL, e.g. "
            f"{DEFAULT_OLLAMA_BASE_URL} — got {value!r}."
        )
    if not parts.netloc:
        raise ConfigError(f"{name} must include a host — got {value!r}.")
    if "@" in parts.netloc:
        # A credential in a URL ends up in every log line and process listing
        # that prints it. Ollama has no auth; if that changes it gets a
        # dedicated variable read server-side.
        raise ConfigError(
            f"{name} must not contain a username or password — put credentials "
            f"in the deployment's secret store, never in a URL."
        )
    if parts.path not in ("", "/"):
        raise ConfigError(
            f"{name} must be the Ollama ROOT with no path — the service "
            f"appends /api/chat itself. Use {parts.scheme}://{parts.netloc}."
        )

    return f"{parts.scheme}://{parts.netloc}"


def _shared_secret(raw: Mapping[str, str], name: str) -> str | None:
    """Validate the bearer token, or return None to leave authentication off.

    The ONLY validator here that must not quote the value it was given. Every
    other one shows `{value!r}` because seeing the typo is the fix; this one's
    value is a credential, and a ConfigError message is printed to stderr by
    `python -m capture_service`, captured by `docker logs`, and pasted into
    issue trackers. So the message reports the LENGTH and nothing else — enough
    to tell "empty" from "too short" without publishing the secret.
    """
    value = _value(raw, name)
    if not value:
        # Empty means off, not invalid: that is the documented laptop default,
        # where the service binds 127.0.0.1 and nothing off-box can reach it.
        return None
    if len(value) < MIN_SHARED_SECRET_LENGTH:
        raise ConfigError(
            f"{name} is set but only {len(value)} character(s) long; it must be "
            f"at least {MIN_SHARED_SECRET_LENGTH}. This is the only thing "
            f"between a caller and a service that accepts meeting recordings, "
            f"so generate a strong one — `openssl rand -hex 32`, or re-run "
            f"install.sh, which does it for you. To switch authentication off "
            f"entirely, unset the variable instead of weakening it."
        )
    return value


def _allowed_origins(raw: Mapping[str, str], name: str) -> list[str] | None:
    """Parse the CORS origin allowlist.

    Returns None when the variable is unset or empty (no CORS middleware), or a
    list of validated origins. A wildcard ``*`` aborts the entire list — a
    wildcard next to the shared-secret header is the mistake this guard exists
    for, so the service refuses to add CORS at all rather than allow every
    origin. Individual entries with a path component or trailing slash are
    logged and skipped; the remaining valid entries still work.
    """
    value = _value(raw, name)
    if not value:
        return None
    entries = [e.strip() for e in value.split(",")]
    if "*" in entries:
        logger.error(
            "CAPTURE_ALLOWED_ORIGINS contains '*'; refusing to add CORS "
            "rather than allow every origin alongside the shared-secret header"
        )
        return None
    origins: list[str] = []
    for entry in entries:
        if not entry:
            continue
        parsed = urlsplit(entry)
        if not parsed.scheme or not parsed.netloc:
            logger.warning(
                "CAPTURE_ALLOWED_ORIGINS: skipping invalid origin %r", entry
            )
            continue
        if parsed.path not in ("", "/"):
            logger.warning(
                "CAPTURE_ALLOWED_ORIGINS: skipping %r (has a path component)",
                entry,
            )
            continue
        if entry.endswith("/"):
            logger.warning(
                "CAPTURE_ALLOWED_ORIGINS: skipping %r (trailing slash)", entry
            )
            continue
        origins.append(entry)
    return origins or None
