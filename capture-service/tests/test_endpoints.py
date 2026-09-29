"""The HTTP surface: /health, /capture, /transcribe, and every failure path.

These are the tests that matter for T4.4: the browser client will POST a
recording here and re-validate the reply with the same strict parser it uses for
the cloud endpoint, so the envelope has to be exactly `{"cards": [...]}` and
every failure has to be a code it can switch on.
"""

from __future__ import annotations

import io
import json
import logging
import tempfile
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from capture_service import __version__
from capture_service.errors import (
    LlmModelNotFound,
    LlmOutputTruncated,
    LlmTimeout,
    LlmUnreachable,
    TranscriberUnavailable,
    TranscriptionFailed,
    UploadTooLarge,
)
from capture_service.main import READ_CHUNK_BYTES, _safe_suffix, _spool_upload
from capture_service.parse_cards import validate_extraction_payload
from capture_service.schemas import DEFAULT_SLIDE_TITLE
from capture_service.transcribe import MAX_TRANSCRIPT_CHARS
from conftest import (
    FAKE_AUDIO,
    SECRET_SPEECH,
    VALID_CARD,
    FakeLlm,
    FakeTranscriber,
    Service,
    cards_payload,
    make_chunk,
    sentinel_chunk,
)


# ─── /health ────────────────────────────────────────────────────────────────


def test_health_reports_the_configuration(service: Service) -> None:
    response = service.client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "capture-service",
        "version": __version__,
        "whisper": {
            "model": "base.en",
            "device": "cpu",
            "computeType": "int8",
            "loaded": True,
        },
        "llm": {
            "baseUrl": "http://127.0.0.1:11434",
            "model": "qwen2.5:7b",
        },
        "limits": {
            "maxUploadBytes": 200 * 1024 * 1024,
            "maxTranscriptChars": 200_000,
            "maxTranscriptChunks": 2_000,
        },
    }


def test_health_reflects_the_environment_it_was_configured_with(make_service) -> None:
    bundle = make_service(
        env={
            "CAPTURE_WHISPER_MODEL": "large-v3",
            "CAPTURE_WHISPER_DEVICE": "cuda",
            "CAPTURE_OLLAMA_BASE_URL": "http://ollama.lan:11434",
            "CAPTURE_OLLAMA_MODEL": "qwen2.5:7b-instruct",
            "CAPTURE_MAX_UPLOAD_BYTES": "1048576",
        }
    )
    body = bundle.client.get("/health").json()
    assert body["whisper"]["model"] == "large-v3"
    assert body["whisper"]["device"] == "cuda"
    assert body["llm"]["baseUrl"] == "http://ollama.lan:11434"
    assert body["llm"]["model"] == "qwen2.5:7b-instruct"
    assert body["limits"]["maxUploadBytes"] == 1048576


def test_health_reports_whether_the_model_is_in_memory(make_service) -> None:
    # An install script polls this. `loaded` must not TRIGGER a load, or the
    # first health probe would download a model.
    cold = make_service(transcriber=FakeTranscriber(loaded=False))
    assert cold.client.get("/health").json()["whisper"]["loaded"] is False
    warm = make_service(transcriber=FakeTranscriber(loaded=True))
    assert warm.client.get("/health").json()["whisper"]["loaded"] is True


def test_health_needs_no_backend_and_performs_no_io(make_service) -> None:
    # Both fakes would raise if they were touched; /health only reads config.
    bundle = make_service(
        transcriber=FakeTranscriber(error=RuntimeError("must not be called")),
        llm=FakeLlm(error=RuntimeError("must not be called")),
    )
    assert bundle.client.get("/health").status_code == 200


def test_health_carries_no_credential_and_no_path(service: Service) -> None:
    body = json.dumps(service.client.get("/health").json())
    for forbidden in ("key", "secret", "token", "password", tempfile.gettempdir()):
        assert forbidden not in body.lower()


# ─── /capture: the success path ─────────────────────────────────────────────


def test_capture_returns_exactly_the_cards_envelope(service: Service) -> None:
    response = service.post_capture()
    assert response.status_code == 200
    body = response.json()
    # No transport metadata. validateExtractionPayload on the client rejects
    # unknown keys, so {"cards": [...], "tookMs": 42} would be a broken reply.
    assert set(body) == {"cards"}
    assert len(body["cards"]) == 1


def test_the_returned_card_is_in_the_typescript_wire_shape(service: Service) -> None:
    card = service.post_capture().json()["cards"][0]
    assert set(card) == {
        "id",
        "type",
        "agentId",
        "title",
        "description",
        "timestamp",
        "details",
    }
    assert card["type"] == "RISK"
    assert card["agentId"] == "speaker-1"
    assert card["details"] == {
        "priority": "High",
        "status": "Open",
        "impact": "Warranty returns",
    }
    assert card["id"].startswith("insight-")
    assert isinstance(card["timestamp"], int)


def test_the_client_side_parser_accepts_our_own_response(service: Service) -> None:
    # This is the round trip T4.4 depends on: extractClient.ts re-validates the
    # body with the strict parser, extra keys and all.
    body = service.post_capture().json()
    cards = validate_extraction_payload(body, now=lambda: 0, new_id=lambda i: f"x{i}")
    assert len(cards) == 1
    assert cards[0].title == VALID_CARD["title"]


def test_an_empty_batch_of_cards_is_a_successful_response(make_service) -> None:
    bundle = make_service(llm=FakeLlm(reply='{"cards": []}'))
    response = bundle.post_capture()
    assert response.status_code == 200
    assert response.json() == {"cards": []}


def test_the_transcript_reaches_the_llm_as_a_labelled_window(service: Service) -> None:
    service.post_capture(
        fields={
            "agendaIdx": "4",
            "slideTitle": "Rear triangle weld",
            "hoveredPartName": "Bracket",
            "laserTargetPartName": "Seat stay",
        }
    )
    prompt = service.llm.last_user_prompt
    lines = prompt.split("\n")
    assert lines[0].startswith("Today's date: ")
    assert lines[1].startswith("Next 14 days: ")
    assert lines[2] == "Agenda item 4: Rear triangle weld"
    assert "A speaker was hovering over: Bracket" in prompt
    assert "The laser pointer was on: Seat stay" in prompt
    assert "Transcript window:" in prompt
    assert "c0 [00:00-00:04] speaker-1:" in prompt


def test_context_fields_are_optional(service: Service) -> None:
    service.post_capture()
    prompt = service.llm.last_user_prompt
    lines = prompt.split("\n")
    assert lines[0].startswith("Today's date: ")
    assert lines[1].startswith("Next 14 days: ")
    assert lines[2] == f"Agenda item 0: {DEFAULT_SLIDE_TITLE}"
    assert "hovering" not in prompt
    assert "laser" not in prompt


def test_a_blank_slide_title_falls_back_to_the_default(service: Service) -> None:
    # Labelling the prompt "Agenda item 0: " would be worse than the honest
    # default, so a blank value is treated as absent.
    service.post_capture(fields={"slideTitle": "   "})
    assert DEFAULT_SLIDE_TITLE in service.llm.last_user_prompt


def test_a_blank_spatial_context_is_omitted_not_rendered(service: Service) -> None:
    service.post_capture(fields={"hoveredPartName": "", "laserTargetPartName": "  "})
    prompt = service.llm.last_user_prompt
    assert "hovering" not in prompt
    assert "laser pointer" not in prompt


def test_the_system_prompt_is_the_shared_extraction_prompt(service: Service) -> None:
    from capture_service.prompt import EXTRACTION_SYSTEM_PROMPT

    service.post_capture()
    assert service.llm.last_system_prompt == EXTRACTION_SYSTEM_PROMPT


def test_the_llm_is_called_exactly_once_per_request(service: Service) -> None:
    service.post_capture()
    assert service.llm.call_count == 1


def test_a_card_with_no_speaker_is_attributed_to_the_first_one(make_service) -> None:
    anonymous = dict(VALID_CARD)
    del anonymous["agentId"]
    bundle = make_service(
        transcriber=FakeTranscriber([make_chunk("Something.", speaker_id="speaker-7")]),
        llm=FakeLlm(reply=cards_payload(anonymous)),
    )
    assert bundle.post_capture().json()["cards"][0]["agentId"] == "speaker-7"


def test_the_recording_reaches_the_transcriber_intact(service: Service) -> None:
    service.post_capture(audio=FAKE_AUDIO)
    assert service.transcriber.sizes == [len(FAKE_AUDIO)]


def test_the_spooled_recording_is_deleted_after_the_request(service: Service) -> None:
    service.post_capture()
    assert service.transcriber.paths, "the transcriber should have been called"
    for path in service.transcriber.paths:
        assert not path.exists()


def test_the_spooled_recording_is_deleted_after_a_failure(make_service) -> None:
    bundle = make_service(llm=FakeLlm(error=LlmUnreachable("down")))
    assert bundle.post_capture().status_code == 502
    for path in bundle.transcriber.paths:
        assert not path.exists()


def test_a_filename_cannot_escape_the_temp_directory(service: Service) -> None:
    # The suffix is client-controlled text. Only a short alphanumeric extension
    # may reach the filesystem, so no separator or ".." survives.
    service.post_capture(filename="../../../../etc/passwd")
    path = service.transcriber.paths[0]
    assert path.parent == Path(tempfile.gettempdir())
    assert path.name.startswith("capture-upload-")
    assert ".." not in path.name


@pytest.mark.parametrize(
    ("filename", "expected_suffix"),
    [
        ("meeting.wav", ".wav"),
        ("MEETING.MP3", ".mp3"),
        ("no-extension", ""),
        ("", ""),
        ("../../evil.sh", ".sh"),
        ("trailing.dot.", ""),
        ("verylongextensionname.audioformat", ""),
        ("with space.wav", ".wav"),
    ],
)
def test_only_a_safe_extension_is_appended_to_the_temp_file(
    filename: str, expected_suffix: str
) -> None:
    assert _safe_suffix(filename) == expected_suffix


# ─── /capture: the upload limit ─────────────────────────────────────────────


def test_an_oversized_upload_is_rejected(make_service) -> None:
    bundle = make_service(env={"CAPTURE_MAX_UPLOAD_BYTES": "32"})
    response = bundle.post_capture(audio=b"x" * 64)
    assert response.status_code == 413
    assert response.json() == {"error": "upload_too_large", "maxUploadBytes": 32}


def test_an_oversized_upload_never_reaches_whisper_or_the_llm(make_service) -> None:
    # The point of the limit is that a 4 GB recording costs nothing: no
    # transcription, no inference, no temp file left behind.
    bundle = make_service(env={"CAPTURE_MAX_UPLOAD_BYTES": "32"})
    bundle.post_capture(audio=b"x" * 4096)
    assert bundle.transcriber.paths == []
    assert bundle.llm.call_count == 0


def test_an_upload_exactly_at_the_limit_is_accepted(make_service) -> None:
    bundle = make_service(env={"CAPTURE_MAX_UPLOAD_BYTES": str(len(FAKE_AUDIO))})
    assert bundle.post_capture(audio=FAKE_AUDIO).status_code == 200


def test_an_upload_one_byte_over_the_limit_is_rejected(make_service) -> None:
    bundle = make_service(env={"CAPTURE_MAX_UPLOAD_BYTES": str(len(FAKE_AUDIO) - 1)})
    assert bundle.post_capture(audio=FAKE_AUDIO).status_code == 413


def test_an_empty_upload_is_rejected(service: Service) -> None:
    response = service.post_capture(audio=b"")
    assert response.status_code == 400
    assert response.json() == {"error": "empty_upload"}


def test_the_streaming_counter_enforces_the_limit_without_a_content_length() -> None:
    # A chunked request declares no size, so the fast path cannot fire. The
    # counter in _spool_upload is what actually guarantees the ceiling, and it
    # stops reading instead of buffering the whole body first.
    class DeclaredSizeUnknown:
        filename = "meeting.wav"
        size = None
        file = io.BytesIO(b"x" * (READ_CHUNK_BYTES + 10))

    with pytest.raises(UploadTooLarge):
        _spool_upload(DeclaredSizeUnknown(), READ_CHUNK_BYTES)


def test_the_streaming_counter_accepts_an_upload_under_the_limit() -> None:
    class DeclaredSizeUnknown:
        filename = "meeting.wav"
        size = None
        file = io.BytesIO(b"x" * 1024)

    path = _spool_upload(DeclaredSizeUnknown(), 2048)
    try:
        assert path.read_bytes() == b"x" * 1024
    finally:
        path.unlink(missing_ok=True)


def test_a_rejected_upload_leaves_no_temp_file_behind() -> None:
    class DeclaredSizeUnknown:
        filename = "meeting.wav"
        size = None
        file = io.BytesIO(b"x" * 5000)

    before = set(Path(tempfile.gettempdir()).glob("capture-upload-*"))
    with pytest.raises(UploadTooLarge):
        _spool_upload(DeclaredSizeUnknown(), 1000)
    after = set(Path(tempfile.gettempdir()).glob("capture-upload-*"))
    assert after == before


# ─── /capture: request validation ───────────────────────────────────────────


def test_a_missing_audio_part_is_a_400_naming_the_field(service: Service) -> None:
    response = service.post_capture(include_audio=False, fields={"agendaIdx": "1"})
    assert response.status_code == 400
    body = response.json()
    assert body["error"] == "invalid_request"
    assert "audio" in body["fields"]


def test_a_non_numeric_agenda_item_is_a_400_that_does_not_echo_the_value(
    service: Service,
) -> None:
    response = service.post_capture(fields={"agendaIdx": SECRET_SPEECH})
    assert response.status_code == 400
    body = response.json()
    assert body["error"] == "invalid_request"
    assert body["fields"] == ["agendaIdx"]
    # Pydantic's default 422 body quotes `input`. Ours must not.
    assert SECRET_SPEECH not in response.text


def test_a_negative_agenda_item_is_rejected(service: Service) -> None:
    assert service.post_capture(fields={"agendaIdx": "-1"}).status_code == 400


def test_a_huge_agenda_item_is_still_an_integer(service: Service) -> None:
    assert service.post_capture(fields={"agendaIdx": "9007199254740993"}).status_code == 200


def test_an_unknown_form_field_is_ignored(service: Service) -> None:
    # Multipart forms are not a JSON body; an extra field is how a client
    # passes a debug flag, and rejecting it would be gratuitously strict.
    assert service.post_capture(fields={"roomId": "room-1"}).status_code == 200


def test_a_get_to_the_post_only_routes_is_a_405_with_an_allow_header(
    service: Service,
) -> None:
    response = service.client.get("/capture")
    assert response.status_code == 405
    assert response.json() == {"error": "method_not_allowed"}
    assert "POST" in response.headers["allow"]


def test_an_unknown_path_is_a_404_with_the_service_error_shape(
    service: Service,
) -> None:
    response = service.client.get("/api/capture")
    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


# ─── /capture: transcript problems ─────────────────────────────────────────


def test_a_silent_recording_is_an_empty_transcript(make_service) -> None:
    bundle = make_service(transcriber=FakeTranscriber([]))
    response = bundle.post_capture()
    assert response.status_code == 422
    assert response.json() == {"error": "empty_transcript"}
    # No transcript means nothing to extract from: the LLM is not called.
    assert bundle.llm.call_count == 0


def test_a_transcript_over_the_prompt_budget_is_rejected(make_service) -> None:
    bundle = make_service(
        transcriber=FakeTranscriber([make_chunk("x" * (MAX_TRANSCRIPT_CHARS + 1))])
    )
    response = bundle.post_capture()
    assert response.status_code == 413
    assert response.json() == {"error": "transcript_too_large"}
    assert bundle.llm.call_count == 0


def test_a_transcription_failure_is_a_500(make_service) -> None:
    bundle = make_service(
        transcriber=FakeTranscriber(error=TranscriptionFailed("decoder said no"))
    )
    response = bundle.post_capture()
    assert response.status_code == 500
    assert response.json() == {"error": "transcription_failed"}


def test_a_missing_whisper_install_is_a_503(make_service) -> None:
    bundle = make_service(
        transcriber=FakeTranscriber(
            error=TranscriberUnavailable("faster-whisper is not installed")
        )
    )
    response = bundle.post_capture()
    assert response.status_code == 503
    assert response.json() == {"error": "transcriber_unavailable"}


# ─── /capture: LLM problems ────────────────────────────────────────────────

LLM_FAILURES: list[tuple[str, Exception, int, str]] = [
    ("unreachable", LlmUnreachable("no route to host"), 502, "capture_upstream_unreachable"),
    ("timeout", LlmTimeout("timed out"), 504, "capture_upstream_timeout"),
    (
        "model not pulled",
        LlmModelNotFound("model 'deepseek-r1:7b' not found"),
        503,
        "capture_model_not_found",
    ),
    ("output truncated", LlmOutputTruncated("ran out of tokens"), 422, "capture_output_truncated"),
]


@pytest.mark.parametrize(
    ("label", "error", "status", "code"), LLM_FAILURES, ids=[e[0] for e in LLM_FAILURES]
)
def test_llm_failures_map_to_their_own_code(
    make_service, label: str, error: Exception, status: int, code: str
) -> None:
    bundle = make_service(llm=FakeLlm(error=error))
    response = bundle.post_capture()
    assert response.status_code == status, label
    assert response.json() == {"error": code}, label


@pytest.mark.parametrize(
    ("label", "reply", "expected_body"),
    [
        ("prose", "I could not find any risks in this meeting.", {"error": "capture_parse_error", "reason": "prose"}),
        ("empty", "", {"error": "capture_parse_error", "reason": "prose"}),
        (
            "unclosed fence",
            '```json\n{"cards": []}',
            {"error": "capture_parse_error", "reason": "markdown_fenced"},
        ),
        (
            "truncated",
            '{"cards": [{"type": "RISK", "tit',
            {"error": "capture_parse_error", "reason": "truncated_json"},
        ),
        ("bare array", "[]", {"error": "capture_parse_error", "reason": "wrong_envelope"}),
        (
            "renamed envelope",
            '{"insights": []}',
            {"error": "capture_parse_error", "reason": "wrong_envelope"},
        ),
        (
            "invented envelope field",
            '{"cards": [], "tookMs": 12}',
            {"error": "capture_parse_error", "reason": "extra_fields"},
        ),
        (
            "invented card field",
            cards_payload(dict(VALID_CARD, confidence=0.9)),
            {"error": "capture_parse_error", "reason": "extra_fields", "cardIndex": 0},
        ),
        (
            "bad priority",
            cards_payload(dict(VALID_CARD, details={"priority": "Urgent"})),
            {"error": "capture_parse_error", "reason": "invalid_card", "cardIndex": 0},
        ),
        (
            "missing title",
            cards_payload({k: v for k, v in VALID_CARD.items() if k != "title"}),
            {"error": "capture_parse_error", "reason": "invalid_card", "cardIndex": 0},
        ),
    ],
)
def test_unparseable_model_output_is_a_422_carrying_only_the_reason(
    make_service, label: str, reply: str, expected_body: dict[str, Any]
) -> None:
    bundle = make_service(llm=FakeLlm(reply=reply))
    response = bundle.post_capture()
    assert response.status_code == 422, label
    # A code, a reason enum and at most a card index — never the model's reply,
    # which quotes the transcript.
    assert response.json() == expected_body, label


def test_a_parse_failure_names_the_card_that_failed(make_service) -> None:
    bundle = make_service(
        llm=FakeLlm(
            reply=cards_payload(VALID_CARD, dict(VALID_CARD, type="HAZARD"))
        )
    )
    assert bundle.post_capture().json() == {
        "error": "capture_parse_error",
        "reason": "invalid_card",
        "cardIndex": 1,
    }


# ─── Nothing sensitive crosses the wire or reaches the log ──────────────────
#
# The sentinel stands in for the transcript, and every case below puts it
# somewhere it could plausibly leak: the model's reply, a failing card, or a
# chunk the transcriber produced. A SUCCESSFUL card may legitimately quote a
# speaker (that is what `description` is for); an error response or a log line
# may not.


def leaky_llm_prose() -> FakeLlm:
    return FakeLlm(reply=f"I heard someone say {SECRET_SPEECH}, so here you go.")


def leaky_llm_truncated_json() -> FakeLlm:
    return FakeLlm(reply='{"cards": [{"title": "' + SECRET_SPEECH)


def leaky_llm_invalid_card() -> FakeLlm:
    # A card that quotes the transcript AND has a bad enum, so it is rejected.
    return FakeLlm(
        reply=cards_payload(dict(VALID_CARD, type="HAZARD", description=SECRET_SPEECH))
    )


def leaky_llm_invented_field() -> FakeLlm:
    return FakeLlm(reply=cards_payload(dict(VALID_CARD, **{SECRET_SPEECH: 1})))


@pytest.mark.parametrize(
    "make_llm",
    [
        pytest.param(leaky_llm_prose, id="prose-reply"),
        pytest.param(leaky_llm_truncated_json, id="truncated-reply"),
        pytest.param(leaky_llm_invalid_card, id="invalid-card-reply"),
        pytest.param(leaky_llm_invented_field, id="invented-field-reply"),
    ],
)
def test_a_failure_never_returns_transcript_text(
    make_service, make_llm: Callable[[], FakeLlm]
) -> None:
    bundle = make_service(llm=make_llm())
    bundle.transcriber.chunks = [sentinel_chunk()]
    response = bundle.post_capture()
    assert response.status_code >= 400
    assert SECRET_SPEECH not in response.text


def test_a_transcription_failure_never_returns_transcript_text(make_service) -> None:
    bundle = make_service(
        transcriber=FakeTranscriber(
            [sentinel_chunk()], error=TranscriptionFailed("decoder said no")
        )
    )
    response = bundle.post_capture()
    assert response.status_code == 500
    assert SECRET_SPEECH not in response.text


def test_an_llm_failure_never_returns_transcript_text(make_service) -> None:
    bundle = make_service(llm=FakeLlm(error=LlmUnreachable("connection refused")))
    bundle.transcriber.chunks = [sentinel_chunk()]
    response = bundle.post_capture()
    assert response.status_code == 502
    assert SECRET_SPEECH not in response.text


@pytest.mark.parametrize(
    "build",
    [
        pytest.param(lambda: {"llm": leaky_llm_prose()}, id="prose-reply"),
        pytest.param(lambda: {"llm": leaky_llm_invalid_card()}, id="invalid-card-reply"),
        pytest.param(
            lambda: {"llm": FakeLlm(error=LlmUnreachable("connection refused"))},
            id="llm-unreachable",
        ),
        pytest.param(
            lambda: {"llm": FakeLlm(error=LlmTimeout("timed out"))}, id="llm-timeout"
        ),
        pytest.param(
            lambda: {
                "transcriber": FakeTranscriber(
                    [sentinel_chunk()], error=TranscriptionFailed("decoder said no")
                )
            },
            id="transcription-failed",
        ),
    ],
)
def test_a_failure_never_logs_transcript_text(
    make_service, build: Callable[[], dict[str, Any]], caplog: pytest.LogCaptureFixture
) -> None:
    # The transcript itself carries the sentinel, so a log line that quoted the
    # transcript, the prompt, or the model's reply would contain it.
    replacements = build()
    bundle = make_service(**replacements)
    if "transcriber" not in replacements:
        bundle.transcriber.chunks = [sentinel_chunk()]
    with caplog.at_level(logging.DEBUG, logger="capture_service"):
        bundle.post_capture()
    assert SECRET_SPEECH not in caplog.text


def test_a_successful_capture_logs_counts_not_content(
    service: Service, caplog: pytest.LogCaptureFixture
) -> None:
    service.transcriber.chunks = [sentinel_chunk()]
    with caplog.at_level(logging.DEBUG, logger="capture_service"):
        assert service.post_capture().status_code == 200
    assert SECRET_SPEECH not in caplog.text
    assert "1 chunk(s) transcribed" in caplog.text


def test_an_unhandled_exception_is_a_bare_500(make_service) -> None:
    # The catch-all handler exists so that a bug cannot become a stack trace in
    # a client's hands. raise_server_exceptions=False to see the real response.
    bundle = make_service(llm=FakeLlm(error=RuntimeError(f"bug touching {SECRET_SPEECH}")))
    lenient = TestClient(bundle.client.app, raise_server_exceptions=False)
    response = lenient.post(
        "/capture", files={"audio": ("m.wav", FAKE_AUDIO, "audio/wav")}
    )
    assert response.status_code == 500
    assert response.json() == {"error": "internal_error"}
    assert SECRET_SPEECH not in response.text


# ─── /transcribe ────────────────────────────────────────────────────────────


def test_transcribe_returns_the_transcript_without_calling_the_llm(
    service: Service,
) -> None:
    response = service.post_transcribe()
    assert response.status_code == 200
    assert response.json() == {
        "transcript": [
            {
                "speakerId": "speaker-1",
                "text": "The bracket weld will crack under load.",
                "startMs": 0,
                "endMs": 4200,
            }
        ]
    }
    assert service.llm.call_count == 0


def test_transcribe_can_return_an_empty_transcript(service: Service) -> None:
    service.transcriber.chunks = []
    assert service.post_transcribe().json() == {"transcript": []}


def test_transcribe_enforces_the_same_upload_limit(make_service) -> None:
    bundle = make_service(env={"CAPTURE_MAX_UPLOAD_BYTES": "8"})
    response = bundle.post_transcribe()
    assert response.status_code == 413
    assert response.json()["error"] == "upload_too_large"


def test_transcribe_deletes_the_recording(service: Service) -> None:
    service.post_transcribe()
    for path in service.transcriber.paths:
        assert not path.exists()


# ─── OpenAPI ────────────────────────────────────────────────────────────────


def test_the_documented_routes_are_the_only_routes(service: Service) -> None:
    schema = service.client.get("/openapi.json").json()
    assert set(schema["paths"]) == {
        "/health",
        "/capture",
        "/transcribe",
        "/extract",
        "/summarize",
    }
    assert schema["paths"]["/capture"]["post"]["responses"]["200"] is not None
    # The error vocabulary is published too, so T4.4 does not have to guess it.
    assert "413" in schema["paths"]["/capture"]["post"]["responses"]


def test_the_published_capture_response_schema_has_no_extra_properties(
    service: Service,
) -> None:
    schema = service.client.get("/openapi.json").json()
    card = schema["components"]["schemas"]["InsightCard"]
    assert set(card["properties"]) == {
        "id",
        "type",
        "agentId",
        "title",
        "description",
        "timestamp",
        "details",
        "relatedPoiId",
        "sourceMessageIds",
        # Published because the TypeScript InsightCard has them and the browser
        # re-validates this service's reply against the same strict allowlist —
        # but this service never fills them in: a card it parsed was written by a
        # model, so it is an AI card (see test_parse_cards.FULL_CARD).
        "source",
        "createdByName",
        "affectedRequirementIds",
        "kbRecommendations",
    }
    assert card["additionalProperties"] is False


# ─── Grounded-capture form fields ──────────────────────────────────────────


def test_bad_component_tree_json_is_ignored_and_capture_succeeds(
    service: Service,
) -> None:
    response = service.post_capture(fields={"componentTree": "not json at all"})
    assert response.status_code == 200
    assert len(response.json()["cards"]) == 1


def test_wrong_shape_component_tree_is_ignored(service: Service) -> None:
    response = service.post_capture(fields={"componentTree": '{"not": "an array"}'})
    assert response.status_code == 200


def test_oversized_component_tree_is_capped(service: Service) -> None:
    import json as _json

    components = [{"id": f"c{i}", "name": f"C{i}", "path": f"C{i}"} for i in range(300)]
    response = service.post_capture(
        fields={"componentTree": _json.dumps(components)}
    )
    assert response.status_code == 200
    # The capture succeeded; the LLM was called with at most 200 components in the prompt.
    user_prompt = service.llm.last_user_prompt
    assert "c199" in user_prompt
    assert "c200" not in user_prompt


def test_bad_pointing_segments_json_is_ignored(service: Service) -> None:
    response = service.post_capture(fields={"pointingSegments": "{broken"})
    assert response.status_code == 200


def test_bad_transcript_hint_json_is_ignored(service: Service) -> None:
    response = service.post_capture(fields={"transcriptHint": "[nope"})
    assert response.status_code == 200


def test_all_three_fields_sent_and_reflected_in_the_prompt(service: Service) -> None:
    import json as _json

    components = [{"id": "left_cup", "name": "Left Cup", "path": "HP / Left Cup"}]
    segments = [
        {
            "userId": "u1",
            "userName": "Alice",
            "partId": "left_cup",
            "partName": "Left Cup",
            "fromMs": 1000,
            "toMs": 5000,
        }
    ]
    hint = [{"speaker": "Alice", "text": "This cup here", "offsetMs": 3000}]
    response = service.post_capture(
        fields={
            "componentTree": _json.dumps(components),
            "pointingSegments": _json.dumps(segments),
            "transcriptHint": _json.dumps(hint),
        }
    )
    assert response.status_code == 200
    user_prompt = service.llm.last_user_prompt
    assert "Components in this model:" in user_prompt
    assert "left_cup · HP / Left Cup" in user_prompt
    assert "What people were pointing at:" in user_prompt
    assert "Alice → Left Cup (1s–5s)" in user_prompt
    assert "Speaker transcript" in user_prompt
    assert "[Alice, t=3s] This cup here" in user_prompt
