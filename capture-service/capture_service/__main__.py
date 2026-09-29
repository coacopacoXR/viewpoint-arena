"""`python -m capture_service` — start the service with uvicorn.

Reads the same environment variables as everything else
(CAPTURE_HOST / CAPTURE_PORT); see capture_service/config.py for the full list.

This exists so the install story in docs/local-capture-plan.md §"Installation"
has one command to run, whether that command is typed by a contributor, written
into a docker-compose `command:` (T5.1) or dropped into a systemd unit. It is a
thin wrapper: `uvicorn capture_service.main:app --host H --port P` does exactly
the same thing if you prefer flags to variables.
"""

from __future__ import annotations

import uvicorn

from .config import load_settings
from .errors import CaptureServiceError
from .main import SERVICE_NAME


def main() -> int:
    try:
        settings = load_settings()
    except CaptureServiceError as exc:
        # One line, naming the variable, instead of a traceback: this is the
        # first thing an installer sees when the generated .env is wrong.
        print(f"{SERVICE_NAME}: configuration error — {exc.message}")
        return 1

    # Import string, not the app object, so uvicorn's own logging setup and
    # signal handling apply unchanged.
    uvicorn.run(
        "capture_service.main:app",
        host=settings.host,
        port=settings.port,
        # No --reload, no workers knob: one Whisper model in RAM is the whole
        # point, and a second worker would load a second copy.
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
