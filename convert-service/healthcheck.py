#!/usr/bin/env python3
"""Container HEALTHCHECK for convert-service.

    python healthcheck.py     -> exit 0 healthy, exit 1 unhealthy

Why a script and not `curl` in the Dockerfile: python:3.12-slim has no curl, and
installing one to run a single GET adds a package to a container that accepts
uploaded files. urllib is already here.

Why it is not a bare TCP check: a container whose port is open but whose
configuration is broken must not be reported healthy, or compose routes traffic
to it and the first person to open a STEP file gets the failure. /health performs
no conversion, so it is cheap enough to poll every 30 s and specific enough to
mean something.

What it deliberately does NOT do is convert anything. A healthcheck that
tessellated a fixture would prove the engine works, and would also run a job on
every probe — with CONVERT_CONCURRENCY=1 that is a healthcheck competing with
real conversions for the only slot, and a container marked unhealthy because it
was busy doing its job.

The shared secret is read from the environment and sent as a header, because
CONVERT_SHARED_SECRET makes EVERY route require it — /health included (see
convert_service/auth.py for why there is no exemption list). Nothing about the
secret is printed: on failure this reports the status code and whether a body was
parseable, never a header value.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# The healthcheck runs inside the container, so the loopback address is right
# regardless of what CONVERT_HOST is bound to (0.0.0.0 in the image).
HOST = "127.0.0.1"
TIMEOUT_SECONDS = 8.0


def main() -> int:
    port = (os.environ.get("CONVERT_PORT") or "8080").strip()
    secret = (os.environ.get("CONVERT_SHARED_SECRET") or "").strip()
    url = f"http://{HOST}:{port}/health"

    request = urllib.request.Request(url, method="GET")
    request.add_header("Accept", "application/json")
    if secret:
        # Must match AUTH_HEADER in convert_service/auth.py.
        request.add_header("X-Convert-Token", secret)

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            status = response.status
            body = response.read(4096)
    except urllib.error.HTTPError as exc:
        # 401 here means the secret in the environment is not the one the service
        # loaded — a real misconfiguration, and exactly what a healthcheck is for.
        print(f"unhealthy: /health returned {exc.code}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - any failure means "not healthy"
        print(
            f"unhealthy: /health could not be reached ({type(exc).__name__})",
            file=sys.stderr,
        )
        return 1

    if status != 200:
        print(f"unhealthy: /health returned {status}", file=sys.stderr)
        return 1

    try:
        payload = json.loads(body)
    except ValueError:
        # Something other than convert-service answered on this port.
        print("unhealthy: /health did not return JSON", file=sys.stderr)
        return 1

    if payload.get("status") != "ok":
        print("unhealthy: /health did not report status ok", file=sys.stderr)
        return 1

    # A service that cannot tessellate is not healthy, however cheerfully it
    # answers: marking it healthy is how compose ends up routing an import to a
    # container that will 503 it. Both fields come from the service's own
    # process, so they see the PATH and the site-packages the jobs will see.
    engine = payload.get("engine") or {}
    if engine.get("ocpFound") is False:
        print("unhealthy: OpenCascade (OCP) is not importable", file=sys.stderr)
        return 1
    if engine.get("gltfpackPath") is None:
        print("unhealthy: gltfpack was not found on PATH", file=sys.stderr)
        return 1

    print("healthy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
