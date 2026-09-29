#!/usr/bin/env python3
"""Container HEALTHCHECK for capture-service.

    python healthcheck.py     -> exit 0 healthy, exit 1 unhealthy

Why a script and not `curl` in the Dockerfile: python:3.12-slim has no curl, and
installing one to run a single GET adds a package to a container that accepts
meeting audio. urllib is already here.

Why it is not a bare TCP check: a container whose port is open but whose
configuration is broken (an unreachable Ollama, a Whisper model that will not
load) must not be reported healthy, or compose routes traffic to it and the
first user to end a meeting gets the failure. /health performs no I/O and never
loads a model, so it is cheap enough to poll every 30s and specific enough to
mean something.

The shared secret is read from the environment and sent as a header, because
CAPTURE_SHARED_SECRET makes EVERY route require it — /health included (see
capture_service/auth.py for why there is no exemption list). Nothing about the
secret is printed: on failure this reports the status code and whether a body
was parseable, never a header value.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# The healthcheck runs inside the container, so the loopback address is right
# regardless of what CAPTURE_HOST is bound to (0.0.0.0 in the image).
HOST = "127.0.0.1"
TIMEOUT_SECONDS = 8.0


def main() -> int:
    port = (os.environ.get("CAPTURE_PORT") or "8080").strip()
    secret = (os.environ.get("CAPTURE_SHARED_SECRET") or "").strip()
    url = f"http://{HOST}:{port}/health"

    request = urllib.request.Request(url, method="GET")
    request.add_header("Accept", "application/json")
    if secret:
        # Must match AUTH_HEADER in capture_service/auth.py.
        request.add_header("X-Capture-Token", secret)

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            status = response.status
            body = response.read(4096)
    except urllib.error.HTTPError as exc:
        # 401 here means the secret in the environment is not the one the
        # service loaded — a real misconfiguration, and exactly what a
        # healthcheck is for.
        print(f"unhealthy: /health returned {exc.code}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - any failure means "not healthy"
        print(f"unhealthy: /health could not be reached ({type(exc).__name__})", file=sys.stderr)
        return 1

    if status != 200:
        print(f"unhealthy: /health returned {status}", file=sys.stderr)
        return 1

    try:
        payload = json.loads(body)
    except ValueError:
        # Something other than capture-service answered on this port.
        print("unhealthy: /health did not return JSON", file=sys.stderr)
        return 1

    if payload.get("status") != "ok":
        print("unhealthy: /health did not report status ok", file=sys.stderr)
        return 1

    print("healthy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
