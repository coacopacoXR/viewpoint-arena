"""Environment configuration for convert-service.

Every setting is an environment variable, with the same rule capture-service
follows: no settings file, no settings UI, no command-line flag that overrides
these. install.sh generates a `.env`, docker-compose passes it to the container,
a bare-metal systemd unit reads it — one mechanism, three deployments.

All variables use the `CONVERT_` prefix and NONE of them use a `VITE_` prefix,
because nothing in this service is ever shipped to a browser. That is the rule
scripts/check-public-env.mjs enforces: a `VITE_` name is inlined into the client
bundle, so a secret in one is a public secret.

Every variable below is a preference EXCEPT `CONVERT_SHARED_SECRET`, which is a
genuine secret: it is the bearer token guarding a service that accepts arbitrary
CAD files and runs a native kernel on them (see auth.py). It never appears in a
response, a log line or a /health body, and install.sh generates it randomly —
a documented default secret is no secret at all.

`CONVERT_MEM_LIMIT` is documented here for completeness but is NOT read by this
module: it is a docker-compose interpolation used for the container's memory
ceiling, exactly like CAPTURE_MEMORY is for capture-service.

Variables (all optional; the defaults are the documented local-install values):

    CONVERT_MAX_UPLOAD_BYTES  Hard ceiling on one uploaded CAD file, in bytes.
                              Default: 209715200 (200 MiB) — the same ceiling
                              the app puts on a model file
                              (MAX_MODEL_FILE_BYTES in utils/modelFormats.ts).
    CONVERT_TIMEOUT_S         Per-conversion wall clock, after which the job's
                              subprocess is killed and the caller gets a 504.
                              Default: 900
    CONVERT_CONCURRENCY       How many conversions may run at once. Extra
                              requests queue rather than fail. Default: 1
    CONVERT_GLTFPACK          gltfpack executable: a path, or a name to look up
                              on PATH. Default: gltfpack
    CONVERT_HOST              Bind address for `python -m convert_service`.
                              Default: 127.0.0.1
    CONVERT_PORT              Bind port for `python -m convert_service`.
                              Default: 8080
    CONVERT_SHARED_SECRET     Bearer token required on EVERY route. Empty (the
                              default) means authentication is off, which is only
                              safe because the service then binds 127.0.0.1.
                              Default: (empty)
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Mapping

from .errors import ConfigError

logger = logging.getLogger("convert_service")

ENV_PREFIX = "CONVERT_"

# 200 MiB, the same ceiling the browser enforces on a model file
# (MAX_MODEL_FILE_BYTES in utils/modelFormats.ts, and the reason
# CAPTURE_MAX_UPLOAD_BYTES has the same value). A file the app would refuse to
# upload is a file this service refuses to tessellate, so the two limits cannot
# drift into "the api accepted it and convert-service rejected it".
DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024

# Fifteen minutes. The browser path gives up after three (CAD_IMPORT_TIMEOUT_MS
# in utils/cadImport.ts) because a person is waiting; a server conversion is
# queued, has no WASM heap ceiling and is done once for everybody, so it is
# worth more patience. It is the same 900 s nginx gives /api/*, which means a
# caller going through the proxy cannot tell this service's 504 from nginx's:
# the api (task 03b) should use a shorter client timeout so it can report
# convert_timeout itself and keep the connection reusable.
DEFAULT_TIMEOUT_SECONDS = 900.0

# One conversion at a time. OpenCascade holds roughly six times the file size in
# memory while tessellating, so two 200 MB jobs at once is a 2.4 GB spike on a
# box that may also be running Ollama. Queueing is the cheaper answer, and the
# queue is bounded by CONVERT_TIMEOUT_S because a job that cannot start in time
# fails rather than waiting for ever.
DEFAULT_CONCURRENCY = 1

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080

# Name, not path: the Dockerfile puts the pinned meshoptimizer release binary on
# PATH, and a contributor running the service on a laptop may have installed it
# anywhere.
DEFAULT_GLTFPACK = "gltfpack"

# The shortest accepted CONVERT_SHARED_SECRET. install.sh generates 64 hex
# characters, so this only ever fires on a hand-written value — and a
# hand-written "changeme" guarding a service that executes a native kernel on
# uploaded files is worth refusing to start over. Empty still means "off".
MIN_SHARED_SECRET_LENGTH = 16

# The complete set of variables this service reads. tests/test_config.py walks
# it, so a variable added to Settings but not to DEFAULTS (or vice versa) fails
# the suite instead of silently becoming unread.
ENV_VAR_NAMES: tuple[str, ...] = (
    "CONVERT_MAX_UPLOAD_BYTES",
    "CONVERT_TIMEOUT_S",
    "CONVERT_CONCURRENCY",
    "CONVERT_GLTFPACK",
    "CONVERT_HOST",
    "CONVERT_PORT",
    "CONVERT_SHARED_SECRET",
)

DEFAULTS: Mapping[str, str] = {
    "CONVERT_MAX_UPLOAD_BYTES": str(DEFAULT_MAX_UPLOAD_BYTES),
    "CONVERT_TIMEOUT_S": str(int(DEFAULT_TIMEOUT_SECONDS)),
    "CONVERT_CONCURRENCY": str(DEFAULT_CONCURRENCY),
    "CONVERT_GLTFPACK": DEFAULT_GLTFPACK,
    "CONVERT_HOST": DEFAULT_HOST,
    "CONVERT_PORT": str(DEFAULT_PORT),
    # No default secret. Ever. A shipped default would be the first thing an
    # attacker tries, and the service would start happily with it.
    "CONVERT_SHARED_SECRET": "",
}


@dataclass(frozen=True, slots=True)
class Settings:
    """Validated, immutable service configuration."""

    max_upload_bytes: int
    timeout_seconds: float
    concurrency: int
    gltfpack: str
    host: str
    port: int
    # None means "authentication is off". Last, with a default, so a caller that
    # only cares about the limits can construct Settings without naming it.
    shared_secret: str | None = None


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Read and validate configuration.

    @param env Injectable for tests; defaults to the process environment.
    @raises ConfigError naming the offending variable and what to do about it.
    """
    raw: Mapping[str, str] = os.environ if env is None else env

    return Settings(
        max_upload_bytes=_positive_int(raw, "CONVERT_MAX_UPLOAD_BYTES"),
        timeout_seconds=_positive_number(raw, "CONVERT_TIMEOUT_S"),
        concurrency=_positive_int(raw, "CONVERT_CONCURRENCY"),
        gltfpack=_value(raw, "CONVERT_GLTFPACK"),
        host=_value(raw, "CONVERT_HOST"),
        port=_port(raw, "CONVERT_PORT"),
        shared_secret=_shared_secret(raw, "CONVERT_SHARED_SECRET"),
    )


# ─── Per-variable validators ────────────────────────────────────────────────
#
# Each one raises a ConfigError that names the variable, shows the value it was
# given and says what a correct value looks like. An IT admin running the
# one-command install sees this once, at start-up, instead of discovering a
# broken value on the first model somebody tries to open.


def _value(raw: Mapping[str, str], name: str) -> str:
    """The variable's value, or its documented default. Whitespace-stripped.

    An EMPTY value counts as unset. A `.env` line like `CONVERT_PORT=` is somebody
    removing a setting, not asking for a port called "" — and this is the same
    rule the shared secret follows, where empty means "authentication off". No
    default in DEFAULTS is empty, so a validator below never sees one.
    """
    return str(raw.get(name) or "").strip() or str(DEFAULTS[name]).strip()


def _positive_int(raw: Mapping[str, str], name: str) -> int:
    value = _value(raw, name)
    try:
        number = int(value)
    except ValueError:
        raise ConfigError(
            f"{name} must be a whole number — got {value!r}, which is not an "
            f"integer. No suffixes: write {DEFAULTS[name]}, not 200MB."
        ) from None
    if number <= 0:
        raise ConfigError(f"{name} must be greater than 0 — got {number}.")
    return number


def _positive_number(raw: Mapping[str, str], name: str) -> float:
    value = _value(raw, name)
    try:
        number = float(value)
    except ValueError:
        raise ConfigError(f"{name} must be a number of seconds — got {value!r}.") from None
    # float() accepts 'nan' and 'inf', which would make every conversion either
    # time out immediately or hang for ever.
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


def _shared_secret(raw: Mapping[str, str], name: str) -> str | None:
    """Validate the bearer token, or return None to leave authentication off.

    The ONLY validator here that must not quote the value it was given. Every
    other one shows `{value!r}` because seeing the typo is the fix; this one's
    value is a credential, and a ConfigError message is printed to stderr by
    `python -m convert_service`, captured by `docker logs`, and pasted into
    issue trackers. So the message reports the LENGTH and nothing else.
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
            f"between a caller and a service that runs a native kernel on "
            f"uploaded files, so generate a strong one — `openssl rand -hex 32`, "
            f"or re-run install.sh, which does it for you. To switch "
            f"authentication off entirely, unset the variable instead of "
            f"weakening it."
        )
    return value
