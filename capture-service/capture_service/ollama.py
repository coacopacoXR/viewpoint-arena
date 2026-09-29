"""Ollama client for the extraction and summary calls.

Mirrors the request lib/connectors/capture/ollamaDirect.ts sends, so the same
model, the same prompt and the same JSON mode produce the same payload whether
the browser talks to Ollama directly (LAN-only, bring-your-own-transcript) or
this service does it after running Whisper. Same knobs, same failure
vocabulary, one behaviour for an operator to learn.

There is no credential in this module and none to configure: Ollama is an
unauthenticated component on the org's own network. If a deployment puts it
behind a proxy that needs a token, that token belongs in the proxy's own
configuration — see config._url_root, which rejects userinfo in the base URL
precisely so a credential cannot be parked there and leak into logs.

`LlmClient` is the seam tests use. Nothing in the test suite constructs a real
OllamaClient against a real server: the HTTP-level tests inject
httpx.MockTransport, and the endpoint tests inject a fake client.
"""

from __future__ import annotations

import json
from typing import Protocol

import httpx

from .prompt import EXTRACTION_JSON_SCHEMA
from .errors import (
    LlmEndpointUnavailable,
    LlmModelNotFound,
    LlmOutputTruncated,
    LlmRequestFailed,
    LlmTimeout,
    LlmUnreachable,
    excerpt,
)

CHAT_PATH = "/api/chat"

# Generous ceiling for the model's answer. Same value the TypeScript providers
# use (MAX_OUTPUT_TOKENS = 4096); a reply that hits it is reported as
# capture_output_truncated rather than parsed as broken JSON.
MAX_OUTPUT_TOKENS = 4096


class LlmClient(Protocol):
    """Anything that can turn a system+user prompt into raw model text."""

    @property
    def name(self) -> str:
        """Human-readable backend name, reported by GET /health."""
        ...

    def complete(
        self,
        system: str,
        user: str,
        *,
        schema: dict[str, object] | None = EXTRACTION_JSON_SCHEMA,
    ) -> str:
        """Return the model's raw text reply.

        @param schema constrains the reply's shape when the backend can. The
                default is the InsightCard schema, because that is what the
                extraction job — the reason this client exists — needs. Pass
                None for a free-text answer (POST /summarize returns markdown)
                and the constraint is omitted entirely: an implementation must
                not fall back to a default here, or a summary would come back
                as JSON-shaped prose or not at all.

        @raises CaptureServiceError subclass when there is no usable reply.
                Implementations must not raise anything else.
        """
        ...


class OllamaClient:
    """Synchronous Ollama client. Satisfies `LlmClient`.

    Synchronous on purpose: every route in this service is a plain `def`, so
    FastAPI runs it in a worker thread. Whisper transcription is blocking and
    CPU/GPU-bound anyway, so an async LLM call would buy nothing and would let
    one meeting's extraction block the event loop for ten seconds.
    """

    def __init__(
        self,
        base_url: str,
        model: str,
        timeout_seconds: float,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url
        self._model = model
        self._timeout_seconds = timeout_seconds
        # `transport` is the test seam: httpx.MockTransport lets the whole
        # client — payload shape, status handling, error mapping — be exercised
        # with no socket and no server.
        self._http = httpx.Client(
            base_url=base_url, timeout=timeout_seconds, transport=transport
        )

    @property
    def name(self) -> str:
        return f"ollama:{self._model}"

    def close(self) -> None:
        self._http.close()

    def complete(
        self,
        system: str,
        user: str,
        *,
        schema: dict[str, object] | None = EXTRACTION_JSON_SCHEMA,
    ) -> str:
        payload: dict[str, object] = {
            "model": self._model,
            # Non-negotiable: a streaming reply would have to be reassembled
            # before it could be parsed, and there is nothing to stream to.
            "stream": False,
            "options": {"temperature": 0, "num_predict": MAX_OUTPUT_TOKENS},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if schema is not None:
            # Ollama's structured-output mode with the exact card schema, not
            # just "some JSON": a live run with plain "json" got the details
            # fields flattened onto the card, and the strict parser rightly
            # refused the lot. parse_cards is still the authority on the shape.
            #
            # The key is OMITTED rather than sent as null when there is no
            # schema, because /summarize asks for markdown: constraining that
            # call to the card schema would make Ollama answer with a card
            # envelope (or refuse), and `format: null` is not documented to
            # mean "unconstrained".
            payload["format"] = schema

        try:
            response = self._http.post(CHAT_PATH, json=payload)
        except httpx.TimeoutException:
            # Checked before the generic branch: an httpx timeout is also an
            # HTTPError, and the two have different fixes.
            raise LlmTimeout(
                f"Ollama did not answer {self._base_url}{CHAT_PATH} within "
                f"{self._timeout_seconds:g}s. A 7B model on CPU takes 5-10s per "
                f"extraction and much longer while a model cold-loads into RAM; "
                f"a 13B+ model wants a GPU. Raise CAPTURE_TIMEOUT_SECONDS, use "
                f"a smaller CAPTURE_OLLAMA_MODEL, or check `ollama ps` on the "
                f"server."
            ) from None
        except httpx.HTTPError as exc:
            raise LlmUnreachable(
                f"Could not reach Ollama at {self._base_url}{CHAT_PATH} "
                f"({type(exc).__name__}). Check, in order: is Ollama running "
                f"there (`ollama serve`); is CAPTURE_OLLAMA_BASE_URL the "
                f"Ollama ROOT reachable FROM THIS SERVICE's host; is Ollama "
                f"bound to an address this container can reach (it listens on "
                f"127.0.0.1 by default — set OLLAMA_HOST=0.0.0.0 on the Ollama "
                f"host)."
            ) from None

        if not 200 <= response.status_code < 300:
            raise self._upstream_error(response)

        # A 200 that is not Ollama: a proxy, an SPA fallback or the wrong port
        # answers 200 text/html for any path. This is exactly what `vite
        # preview` does to every /api/* route in this repo, so it is a failure
        # worth naming instead of surfacing as a JSON decode error.
        content_type = response.headers.get("content-type", "")
        if "application/json" not in content_type:
            raise LlmEndpointUnavailable(
                f"{self._base_url}{CHAT_PATH} answered {response.status_code} "
                f"with {content_type or 'no content type'} instead of JSON. "
                f"Something other than Ollama is answering on that address. "
                f"CAPTURE_OLLAMA_BASE_URL must point at the Ollama API root."
            )

        try:
            data = json.loads(response.text)
        except ValueError:
            raise LlmEndpointUnavailable(
                f"{self._base_url}{CHAT_PATH} returned a body that was not "
                f"valid JSON."
            ) from None

        if not isinstance(data, dict):
            raise LlmEndpointUnavailable(
                f"{self._base_url}{CHAT_PATH} returned valid JSON that was not "
                f"an object."
            )

        if data.get("done_reason") == "length":
            raise LlmOutputTruncated(
                f"Ollama model {self._model!r} ran out of output tokens before "
                f"finishing the JSON. Shorten the recording, or use a model "
                f"with a larger context window."
            )

        message = data.get("message")
        text = message.get("content") if isinstance(message, dict) else None
        if not isinstance(text, str):
            detail = data.get("error")
            raise LlmRequestFailed(
                f"Ollama answered without a message.content string"
                + (
                    f": {excerpt(detail)}"
                    if isinstance(detail, str) and detail.strip()
                    else ""
                )
                + f". Check `ollama ps` and the Ollama server log.",
                response.status_code,
            )

        return text

    def _upstream_error(self, response: httpx.Response) -> Exception:
        """Translate a non-2xx reply.

        Ollama reports a missing model as a 404 with a JSON error body, so the
        404 branch has to read the body to tell "model not pulled" from "that
        address is not Ollama at all". Both are common; the fixes differ.
        """
        try:
            body_text = response.text
        except Exception:  # noqa: BLE001 — an unreadable body is just no body
            body_text = ""

        body_error: object = None
        try:
            body = json.loads(body_text)
            if isinstance(body, dict):
                body_error = body.get("error")
        except ValueError:
            body_error = None

        detail = body_error if isinstance(body_error, str) else excerpt(body_text)

        if isinstance(body_error, str) and "not found" in body_error:
            return LlmModelNotFound(
                f"Ollama does not have the configured model: {excerpt(detail)}. "
                f"Pull it on the Ollama host with "
                f"`ollama pull {self._model}`, or point CAPTURE_OLLAMA_MODEL at "
                f"an installed model (`ollama list`)."
            )

        if response.status_code == 404:
            return LlmEndpointUnavailable(
                f"{self._base_url}{CHAT_PATH} returned 404. That address is "
                f"serving something that is not the Ollama API — "
                f"CAPTURE_OLLAMA_BASE_URL should be the Ollama root (e.g. "
                f"http://127.0.0.1:11434) with no path."
            )

        # Server-log detail only; the HTTP response carries just the code.
        return LlmRequestFailed(
            f"Ollama returned {response.status_code} for "
            f"{self._base_url}{CHAT_PATH}"
            + (f": {excerpt(detail)}" if detail else "")
            + ". The Ollama server log on that host has the detail.",
            response.status_code,
        )
