"""Shared-secret authentication for convert-service.

The same control capture-service uses (capture_service/auth.py), for the same
reason and with the same rules. This service accepts arbitrary CAD files from a
network and hands them to a native kernel that has, historically, been a source
of crashes on malformed input; it will tessellate anything posted to it and hand
back the geometry. So:

  * docker-compose.yml puts it on a network with `internal: true` and publishes
    NO host port. Network isolation is the primary control.
  * install.sh generates a random CONVERT_SHARED_SECRET into `.env`. This module
    is the second control, and the one that still holds when an operator
    publishes the port anyway, when another container on the same network is
    compromised, or when the service is deployed somewhere the compose file has
    never been.

Rules this module keeps
-----------------------
* OPT-IN BY ABSENCE. An unset or empty CONVERT_SHARED_SECRET means no
  authentication, which is the documented laptop default (the service then binds
  127.0.0.1, so nothing off-box can reach it). Set the variable and the service
  starts requiring it — there is no third state and no flag to bypass it.
* EVERY ROUTE, INCLUDING /health AND /docs. One rule with no exemption list,
  because an exemption list is a list somebody extends. /health reports the
  configured limits and whether the engine is present; /docs is an interactive
  console for a service that accepts file uploads. With a secret set, use curl
  (or unset it) to browse /docs locally.
* CONSTANT-TIME COMPARE, via hmac.compare_digest. A byte-by-byte comparison
  leaks the matching prefix through response timing.
* NOTHING ABOUT THE TOKEN IS LOGGED. Not the value, not a prefix, not its length.
  A rejected request logs the method and the PATH only.

Unlike capture-service there is no CORS middleware here, and that is deliberate
rather than an omission: no browser ever calls this service. The api (task 03b)
calls it server-side, the way it calls capture-service, and the model bytes reach
a participant through the app's own model endpoint after the access gate
(requestIsAllowed in api/_lib/models.ts) has run. Adding CORS would mean adding
an origin allowlist for callers that do not exist.
"""

from __future__ import annotations

import hmac
import logging
from typing import Awaitable, Callable

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

logger = logging.getLogger("convert_service")

#: Header a caller sends. Task 03b's api client must use this exact name; the
#: two runtimes share no module format, so tests/test_auth.py pins the string on
#: this side and the api's test pins it on that one.
AUTH_HEADER = "X-Convert-Token"

#: `Authorization: Bearer <secret>` is accepted too, because that is the header a
#: generic HTTP client, a service mesh or an nginx auth_request reaches for
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
    `request.app.state` per request: the value is fixed for the process lifetime,
    and keeping it out of the request path means there is no code path in which a
    request handler can see it.

    The middleware RETURNS a 401 rather than raising. Starlette's user middleware
    sits OUTSIDE the ExceptionMiddleware that runs the handlers registered in
    main._register_error_handlers, so a ConvertServiceError raised here would
    escape to ServerErrorMiddleware and surface as a bare 500 instead of the
    service's one predictable error shape.
    """

    async def middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if token_matches(presented_token(request), secret):
            return await call_next(request)

        # Path only. No query string (a caller could put anything there), no
        # header value, no token length, and no filename — X-File-Name is
        # client-controlled text like any other header.
        logger.warning(
            "convert-service unauthorized: %s %s",
            request.method,
            request.url.path,
        )
        return JSONResponse(
            status_code=UNAUTHORIZED_STATUS, content=dict(UNAUTHORIZED_BODY)
        )

    return middleware
