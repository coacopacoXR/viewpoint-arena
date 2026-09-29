"""CORS middleware tests.

CAPTURE_ALLOWED_ORIGINS is opt-in by absence: unset or empty means no CORS
middleware at all (today's behaviour, unchanged). Set it and the service adds
CORSMiddleware with exactly those origins. A wildcard ``*`` is refused — the
service starts without CORS rather than allowing every origin alongside the
shared-secret header.
"""

from __future__ import annotations

from typing import Callable

from fastapi.testclient import TestClient

from capture_service.config import load_settings
from capture_service.main import create_app
from conftest import FakeLlm, FakeTranscriber, Service


def _build(env: dict[str, str] | None = None) -> TestClient:
    settings = load_settings(env or {})
    app = create_app(settings, FakeTranscriber(), FakeLlm())
    return TestClient(app)


def _preflight(client: TestClient, origin: str) -> "object":
    return client.options(
        "/health",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )


def test_unset_no_cors_headers() -> None:
    """No CAPTURE_ALLOWED_ORIGINS → no Access-Control-Allow-Origin on any request."""
    client = _build()
    response = _preflight(client, "https://example.com")
    assert "access-control-allow-origin" not in response.headers


def test_single_origin_allows_matching_preflight() -> None:
    client = _build({"CAPTURE_ALLOWED_ORIGINS": "https://review.example.com"})
    response = _preflight(client, "https://review.example.com")
    assert response.status_code == 200
    assert (
        response.headers["access-control-allow-origin"]
        == "https://review.example.com"
    )


def test_single_origin_rejects_different_origin() -> None:
    client = _build({"CAPTURE_ALLOWED_ORIGINS": "https://review.example.com"})
    response = _preflight(client, "https://other.example.com")
    assert "access-control-allow-origin" not in response.headers


def test_wildcard_disables_cors_entirely() -> None:
    """A ``*`` in the list is the mistake this guard exists for: refuse it."""
    client = _build({"CAPTURE_ALLOWED_ORIGINS": "*"})
    response = _preflight(client, "https://anything.example.com")
    assert "access-control-allow-origin" not in response.headers


def test_wildcard_mixed_with_valid_origins_still_disables() -> None:
    client = _build(
        {"CAPTURE_ALLOWED_ORIGINS": "https://good.example.com,*"}
    )
    response = _preflight(client, "https://good.example.com")
    assert "access-control-allow-origin" not in response.headers


def test_entry_with_path_is_skipped_valid_ones_still_work() -> None:
    client = _build(
        {
            "CAPTURE_ALLOWED_ORIGINS": (
                "https://bad.example.com/some/path, https://good.example.com"
            )
        }
    )
    # The valid origin works.
    response = _preflight(client, "https://good.example.com")
    assert (
        response.headers["access-control-allow-origin"]
        == "https://good.example.com"
    )
    # The one with a path was skipped.
    response_bad = _preflight(client, "https://bad.example.com")
    assert "access-control-allow-origin" not in response_bad.headers


def test_entry_with_trailing_slash_is_skipped() -> None:
    client = _build(
        {"CAPTURE_ALLOWED_ORIGINS": "https://slash.example.com/, https://ok.example.com"}
    )
    response = _preflight(client, "https://ok.example.com")
    assert (
        response.headers["access-control-allow-origin"] == "https://ok.example.com"
    )
    response_slash = _preflight(client, "https://slash.example.com")
    assert "access-control-allow-origin" not in response_slash.headers


def test_actual_get_request_carries_cors_header() -> None:
    """Not just preflight: a real GET also gets the CORS header."""
    client = _build({"CAPTURE_ALLOWED_ORIGINS": "https://app.example.com"})
    response = client.get(
        "/health", headers={"Origin": "https://app.example.com"}
    )
    assert response.status_code == 200
    assert (
        response.headers["access-control-allow-origin"]
        == "https://app.example.com"
    )


def test_allow_credentials_is_false() -> None:
    """Explicitly False, so browsers do not send cookies on cross-origin calls."""
    client = _build({"CAPTURE_ALLOWED_ORIGINS": "https://app.example.com"})
    response = _preflight(client, "https://app.example.com")
    # CORSMiddleware omits the header when allow_credentials=False.
    assert response.headers.get("access-control-allow-credentials") != "true"


# ── With the shared secret on ────────────────────────────────────────────────
# The combination an operator would actually run: a browser origin allowed AND
# the token required. CORS must sit outside auth, or the tokenless preflight is
# refused with 401 and no browser request ever gets through.

_SECRET = "s" * 32


def test_preflight_passes_without_token_when_secret_is_set() -> None:
    client = _build({
        "CAPTURE_ALLOWED_ORIGINS": "https://review.example.com",
        "CAPTURE_SHARED_SECRET": _SECRET,
    })
    response = client.options(
        "/health",
        headers={
            "Origin": "https://review.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-capture-token",
        },
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "https://review.example.com"
    assert "x-capture-token" in response.headers.get("access-control-allow-headers", "").lower()


def test_rejected_request_still_carries_cors_header_so_the_page_can_read_it() -> None:
    client = _build({
        "CAPTURE_ALLOWED_ORIGINS": "https://review.example.com",
        "CAPTURE_SHARED_SECRET": _SECRET,
    })
    response = client.get("/health", headers={"Origin": "https://review.example.com"})
    assert response.status_code == 401
    assert response.headers.get("access-control-allow-origin") == "https://review.example.com"


def test_token_still_required_for_real_requests() -> None:
    client = _build({
        "CAPTURE_ALLOWED_ORIGINS": "https://review.example.com",
        "CAPTURE_SHARED_SECRET": _SECRET,
    })
    ok = client.get(
        "/health",
        headers={"Origin": "https://review.example.com", "X-Capture-Token": _SECRET},
    )
    assert ok.status_code == 200
