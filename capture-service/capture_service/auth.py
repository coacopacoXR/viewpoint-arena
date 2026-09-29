"""Shared-secret authentication for capture-service (T5.1).

Why this exists
---------------
This service accepts complete meeting recordings — the most sensitive artefact
in the whole product — and until now it had no authentication at all.
capture-service/README.md said to bind it to a private network and
docs/local-capture-plan.md §"Open questions" deferred the mechanism to T5.1:

    Auth for capture-service: shared secret in the docker-compose `.env`,
    validated on every PartyKit→service request. Skip JWT for v1.

That is what this module is. docker-compose.yml puts the service on a network
with `internal: true` and publishes NO host port, and install.sh generates a
random CAPTURE_SHARED_SECRET into `.env` at install time. Network isolation is
the primary control; this is the second one, and it is the one that still holds
when an operator publishes the port anyway, when another container on the same
network is compromised, or when the service is deployed somewhere the compose
file has never been.

Rules this module keeps
-----------------------
* OPT-IN BY ABSENCE. An unset or empty CAPTURE_SHARED_SECRET means no
  authentication, which is the documented laptop default (the service binds
  127.0.0.1, so nothing off-box can reach it). Every existing deployment and
  every test keeps working unchanged. Set the variable and the service starts
  requiring it — there is no third state and no flag to bypass it.
* EVERY ROUTE, INCLUDING /health AND /docs. One rule with no exemption list,
  because an exemption list is a list somebody extends. /health reports the
  Ollama host and model, and /docs is an interactive console for a service that
  takes audio uploads; neither should be readable by whoever can reach the port.
  With a secret set, use curl (or unset it) to browse /docs locally.
* CONSTANT-TIME COMPARE, via hmac.compare_digest. A byte-by-byte comparison
  leaks the matching prefix through response timing, and this secret is the only
  thing between a caller and a transcript pipeline.
* NOTHING ABOUT THE TOKEN IS LOGGED. Not the value, not a prefix, not its
  length. A rejected request logs the method and the PATH only — enough to see
  that something is probing the service, nothing that helps it succeed.
"""

from __future__ import annotations

import hmac
import logging
from typing import Awaitable, Callable

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

logger = logging.getLogger("capture_service")

#: Header the app's server-side probe sends (lib/health/probes.ts).
#:
#: Must match CAPTURE_AUTH_HEADER there. The two runtimes share no module
#: format, so tests/test_typescript_parity.py pins the pair.
AUTH_HEADER = "X-Capture-Token"

#: `Authorization: Bearer <secret>` is accepted too, because that is the header
#: a generic HTTP client, a service mesh or an nginx auth_request reaches for
#: first, and refusing it would only send an operator hunting for a
#: non-standard header name.
AUTHORIZATION_HEADER = "Authorization"
BEARER_PREFIX = "Bearer "

#: The whole 401 body. One machine-readable code and nothing else, matching
#: errors.py's rule that a failure response carries no content: no hint about
#: which header was missing, no echo of what was presented, no realm.
UNAUTHORIZED_BODY: dict[str, str] = {"error": "unauthorized"}

UNAUTHORIZED_STATUS = 401


def presented_token(request: Request) -> str | None:
    """The token a request presented, or None if it presented none.

    Whitespace-stripped, because a secret pasted into a compose file or a curl
    command line picks up a trailing newline often enough that rejecting it
    would cost somebody an hour. config.py strips the configured side the same
    way, so the two agree.
    """
    header = request.headers.get(AUTH_HEADER)
    if header is not None and header.strip():
        return header.strip()

    authorization = request.headers.get(AUTHORIZATION_HEADER)
    if authorization is not None and authorization.strip().startswith(BEARER_PREFIX):
        token = authorization.strip()[len(BEARER_PREFIX) :].strip()
        return token or None

    return None


def token_matches(presented: str | None, expected: str) -> bool:
    """Constant-time comparison. False for a missing token."""
    if presented is None:
        return False
    return hmac.compare_digest(
        presented.encode("utf-8"),
        expected.encode("utf-8"),
    )


def require_shared_secret(
    secret: str,
) -> Callable[[Request, Callable[[Request], Awaitable[Response]]], Awaitable[Response]]:
    """Build the ASGI middleware that enforces `secret` on every request.

    Returned as a closure over the secret rather than reading it off
    `request.app.state` per request: the value is fixed for the process
    lifetime, and keeping it out of the request path means there is no code
    path in which a request handler can see it.

    The middleware RETURNS a 401 rather than raising. Starlette's user
    middleware sits OUTSIDE the ExceptionMiddleware that runs the handlers
    registered in main._register_error_handlers, so a CaptureServiceError
    raised here would escape to ServerErrorMiddleware and surface as a bare 500
    instead of the service's one predictable error shape.
    """

    async def middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if token_matches(presented_token(request), secret):
            return await call_next(request)

        # Path only. No query string (a caller could put anything there), no
        # header value, no token length.
        logger.warning(
            "capture-service unauthorized: %s %s",
            request.method,
            request.url.path,
        )
        return JSONResponse(
            status_code=UNAUTHORIZED_STATUS, content=dict(UNAUTHORIZED_BODY)
        )

    return middleware
