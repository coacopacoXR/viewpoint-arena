"""`python -m convert_service` — start the service with uvicorn.

Reads the same environment variables as everything else (CONVERT_HOST /
CONVERT_PORT); see convert_service/config.py for the full list.

This exists so the install story has one command to run, whether that command is
typed by a contributor, written into a docker-compose `command:` or dropped into
a systemd unit. It is a thin wrapper: `uvicorn convert_service.main:app --host H
--port P` does exactly the same thing if you prefer flags to variables.
"""

from __future__ import annotations

import uvicorn

from .config import load_settings
from .errors import ConvertServiceError
from .main import SERVICE_NAME


def main() -> int:
    try:
        settings = load_settings()
    except ConvertServiceError as exc:
        # One line, naming the variable, instead of a traceback: this is the
        # first thing an installer sees when the generated .env is wrong.
        print(f"{SERVICE_NAME}: configuration error — {exc.message}")
        return 1

    # Import string, not the app object, so uvicorn's own logging setup and
    # signal handling apply unchanged.
    uvicorn.run(
        "convert_service.main:app",
        host=settings.host,
        port=settings.port,
        # No --reload, and no workers knob either: CONVERT_CONCURRENCY is the
        # only concurrency setting this service has, and a second uvicorn worker
        # would quietly double it (each worker has its own semaphore), which is
        # how a memory limit gets exceeded by a service that looks configured.
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
