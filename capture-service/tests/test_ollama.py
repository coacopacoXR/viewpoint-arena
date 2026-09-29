"""The Ollama client, exercised against httpx.MockTransport.

No socket is opened and no server is needed: MockTransport stands in for the
network while the REAL client code runs — payload shape, status handling,
content-type checking and error translation. That matters, because the failure
modes here are the ones an IT admin hits first (Ollama not running, model not
pulled, base URL pointing at something that is not Ollama) and each needs a
different message.
"""

from __future__ import annotations

import json
from typing import Any, Callable

import httpx
import pytest

from capture_service.errors import (
    MAX_LOG_EXCERPT,
    LlmEndpointUnavailable,
    LlmModelNotFound,
    LlmOutputTruncated,
    LlmRequestFailed,
    LlmTimeout,
    LlmUnreachable,
)
from capture_service.ollama import CHAT_PATH, MAX_OUTPUT_TOKENS, OllamaClient
from capture_service.prompt import EXTRACTION_JSON_SCHEMA

BASE_URL = "http://ollama.internal:11434"
MODEL = "deepseek-r1:7b"
SYSTEM = "You are the insight-capture layer."
USER = "Agenda item 2: Weld review\n\nTranscript window:\nc0 [00:00-00:04] speaker-1: Hello."


def make_client(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    base_url: str = BASE_URL,
    model: str = MODEL,
    timeout: float = 5.0,
) -> OllamaClient:
    return OllamaClient(
        base_url, model, timeout, transport=httpx.MockTransport(handler)
    )


def json_reply(payload: dict[str, Any], status: int = 200) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return handler


def content_reply(content: str) -> Callable[[httpx.Request], httpx.Response]:
    return json_reply({"message": {"content": content}, "done_reason": "stop"})


def test_a_successful_reply_returns_the_model_text() -> None:
    client = make_client(content_reply('{"cards": []}'))
    assert client.complete(SYSTEM, USER) == '{"cards": []}'


def test_the_request_is_a_non_streaming_json_mode_chat_completion() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["content_type"] = request.headers.get("content-type")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"content": "{}"}, "done_reason": "stop"})

    make_client(handler).complete(SYSTEM, USER)

    assert seen["method"] == "POST"
    # /api/chat is appended to the configured ROOT.
    assert seen["url"] == f"{BASE_URL}{CHAT_PATH}"
    assert seen["content_type"] == "application/json"
    assert seen["body"] == {
        "model": MODEL,
        "stream": False,
        "format": EXTRACTION_JSON_SCHEMA,
        "options": {"temperature": 0, "num_predict": MAX_OUTPUT_TOKENS},
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": USER},
        ],
    }


def test_a_schema_less_call_omits_the_format_key_entirely() -> None:
    # POST /summarize asks for markdown. Ollama's structured-output mode is
    # switched off by ABSENCE of `format`: sending `format: null` is not
    # documented to mean "unconstrained", and sending the card schema would
    # make the model answer the schema instead of the prompt.
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"message": {"content": "## Actions"}, "done_reason": "stop"})

    reply = make_client(handler).complete(SYSTEM, USER, schema=None)

    assert reply == "## Actions"
    assert "format" not in seen[0]
    # Everything else is unchanged: one knob differs between the two jobs.
    assert seen[0]["stream"] is False
    assert seen[0]["options"] == {"temperature": 0, "num_predict": MAX_OUTPUT_TOKENS}


def test_the_prompt_is_passed_through_verbatim() -> None:
    # The client knows nothing about prompts: whatever the pipeline builds is
    # what Ollama receives, unmodified and untruncated.
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["messages"])
        return httpx.Response(200, json={"message": {"content": "{}"}, "done_reason": "stop"})

    make_client(handler).complete(SYSTEM, USER)
    assert seen[0][0]["content"] == SYSTEM
    assert seen[0][1]["content"] == USER


@pytest.mark.parametrize(
    "model_name", ["deepseek-r1:7b", "qwen2.5:7b-instruct", "llama3.1:8b-instruct"]
)
def test_the_configured_model_is_the_one_requested(model_name: str) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["model"])
        return httpx.Response(200, json={"message": {"content": "{}"}})

    make_client(handler, model=model_name).complete(SYSTEM, USER)
    assert seen == [model_name]


def test_the_client_name_reports_the_model() -> None:
    assert make_client(content_reply("{}")).name == f"ollama:{MODEL}"


# ─── Truncation ─────────────────────────────────────────────────────────────


def test_running_out_of_output_tokens_is_reported_as_truncation() -> None:
    client = make_client(
        json_reply({"message": {"content": '{"cards": [{"ti'}, "done_reason": "length"})
    )
    with pytest.raises(LlmOutputTruncated) as error:
        client.complete(SYSTEM, USER)
    assert error.value.status == 422
    assert error.value.code == "capture_output_truncated"
    # The half-finished JSON is not quoted: it would carry transcript text.
    assert "cards" not in error.value.message


def test_a_stop_that_was_not_a_length_stop_is_not_truncation() -> None:
    client = make_client(
        json_reply({"message": {"content": '{"cards": []}'}, "done_reason": "stop"})
    )
    assert client.complete(SYSTEM, USER) == '{"cards": []}'


# ─── Replies that are not usable ────────────────────────────────────────────


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"message": {}},
        {"message": {"content": None}},
        {"message": {"content": 42}},
        {"message": {"content": ["a"]}},
        {"message": "not an object"},
        {"done": True},
        {"error": "context length exceeded"},
    ],
)
def test_a_reply_without_a_message_content_string_is_an_upstream_error(
    payload: dict[str, Any],
) -> None:
    with pytest.raises(LlmRequestFailed) as error:
        make_client(json_reply(payload)).complete(SYSTEM, USER)
    assert error.value.code == "capture_upstream_error"
    assert error.value.status == 502


def test_ollamas_own_error_field_is_quoted_in_the_log_message_only() -> None:
    client = make_client(json_reply({"error": "context length exceeded (8192)"}))
    with pytest.raises(LlmRequestFailed) as error:
        client.complete(SYSTEM, USER)
    assert "context length exceeded" in error.value.message
    assert error.value.response_body() == {"error": "capture_upstream_error"}


# ─── Non-2xx ────────────────────────────────────────────────────────────────


def test_a_model_that_has_not_been_pulled_says_how_to_pull_it() -> None:
    client = make_client(
        json_reply(
            {"error": f"model '{MODEL}' not found, try pulling or creating a model"},
            status=404,
        )
    )
    with pytest.raises(LlmModelNotFound) as error:
        client.complete(SYSTEM, USER)
    assert error.value.status == 503
    assert error.value.code == "capture_model_not_found"
    assert f"ollama pull {MODEL}" in error.value.message
    assert "ollama list" in error.value.message


def test_a_404_from_something_that_is_not_ollama_is_an_endpoint_problem() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="<html><body>Not Found</body></html>")

    with pytest.raises(LlmEndpointUnavailable) as error:
        make_client(handler).complete(SYSTEM, USER)
    assert error.value.code == "capture_endpoint_unavailable"
    assert "Ollama root" in error.value.message


@pytest.mark.parametrize("status", [400, 401, 403, 500, 502, 503])
def test_an_error_status_is_an_upstream_error(status: int) -> None:
    client = make_client(json_reply({"error": "boom"}, status=status))
    with pytest.raises(LlmRequestFailed) as error:
        client.complete(SYSTEM, USER)
    assert error.value.status == 502
    assert error.value.upstream_status == status


def test_an_error_status_with_an_unreadable_body_is_still_reported() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="")

    with pytest.raises(LlmRequestFailed) as error:
        make_client(handler).complete(SYSTEM, USER)
    assert "500" in error.value.message


# ─── Something else is answering ────────────────────────────────────────────


def test_a_200_that_is_not_json_is_an_endpoint_problem() -> None:
    # The failure this catches in practice: the base URL points at a proxy or an
    # SPA fallback, which answers 200 text/html for every path.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, text="<!doctype html><title>App</title>", headers={"content-type": "text/html"}
        )

    with pytest.raises(LlmEndpointUnavailable) as error:
        make_client(handler).complete(SYSTEM, USER)
    assert error.value.status == 502
    assert "text/html" in error.value.message


def test_a_json_content_type_that_carries_invalid_json_is_an_endpoint_problem() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"{not json", headers={"content-type": "application/json"}
        )

    with pytest.raises(LlmEndpointUnavailable):
        make_client(handler).complete(SYSTEM, USER)


def test_valid_json_that_is_not_an_object_is_an_endpoint_problem() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"[1, 2, 3]", headers={"content-type": "application/json"}
        )

    with pytest.raises(LlmEndpointUnavailable):
        make_client(handler).complete(SYSTEM, USER)


# ─── Transport failures ─────────────────────────────────────────────────────


def test_a_refused_connection_says_what_to_check() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("All connection attempts failed")

    with pytest.raises(LlmUnreachable) as error:
        make_client(handler).complete(SYSTEM, USER)
    assert error.value.status == 502
    assert error.value.code == "capture_upstream_unreachable"
    message = error.value.message
    assert "ollama serve" in message
    assert "CAPTURE_OLLAMA_BASE_URL" in message
    assert "OLLAMA_HOST" in message


@pytest.mark.parametrize(
    "exception",
    [
        httpx.ReadTimeout("read timed out"),
        httpx.ConnectTimeout("connect timed out"),
        httpx.WriteTimeout("write timed out"),
        httpx.PoolTimeout("pool timed out"),
    ],
)
def test_a_timeout_is_distinguished_from_a_refused_connection(
    exception: httpx.TimeoutException,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exception

    with pytest.raises(LlmTimeout) as error:
        make_client(handler, timeout=0.001).complete(SYSTEM, USER)
    assert error.value.status == 504
    assert error.value.code == "capture_upstream_timeout"
    assert "CAPTURE_TIMEOUT_SECONDS" in error.value.message


def test_a_broken_connection_mid_reply_is_unreachable_not_a_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadError("peer closed the connection")

    with pytest.raises(LlmUnreachable):
        make_client(handler).complete(SYSTEM, USER)


# ─── Log hygiene ────────────────────────────────────────────────────────────


def test_a_long_upstream_body_is_bounded_and_flattened() -> None:
    noisy = "line\n" * 400

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": noisy})

    with pytest.raises(LlmRequestFailed) as error:
        make_client(handler).complete(SYSTEM, USER)
    message = error.value.message
    assert len(message) < MAX_LOG_EXCERPT + 200
    # Flattened, so a value containing newlines cannot forge extra log lines.
    assert "\n" not in message
    assert message.count("line") <= MAX_LOG_EXCERPT // len("line ") + 1


def test_no_error_response_body_carries_upstream_detail() -> None:
    failures: list[Callable[[], Any]] = [
        lambda: make_client(json_reply({"error": "secret-detail"}, status=500)).complete(SYSTEM, USER),
        lambda: make_client(json_reply({"error": "model not found"}, status=404)).complete(SYSTEM, USER),
        lambda: make_client(json_reply({"error": "nope"})).complete(SYSTEM, USER),
    ]
    for call in failures:
        with pytest.raises(Exception) as error:
            call()
        body = error.value.response_body()
        assert set(body) == {"error"}
        assert "secret-detail" not in json.dumps(body)


def test_the_client_can_be_closed() -> None:
    # main.py closes the LLM client on shutdown; a closed httpx client refuses
    # further requests rather than silently reconnecting.
    client = make_client(content_reply("{}"))
    client.complete(SYSTEM, USER)
    client.close()
    with pytest.raises(RuntimeError):
        client.complete(SYSTEM, USER)
