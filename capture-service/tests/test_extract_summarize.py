"""POST /extract and POST /summarize — the text halves of the pipeline.

Both exist so the app's server-side AI router can place one JOB with this
service while another goes to a different provider
(docs/plan/14-rooms-models-admin-ai.md): /extract is /capture minus Whisper,
/summarize is the minutes. The tests here are the ones that keep that promise
honest:

  * /extract replies with exactly the envelope /capture replies with, and the
    browser's own strict parser accepts it — a caller cannot tell which route
    produced a card;
  * /extract constrains the model with the extraction JSON schema and
    /summarize does NOT. That asymmetry is the whole reason
    `LlmClient.complete` grew a `schema` keyword: markdown asked for in JSON
    mode comes back as a card envelope or not at all;
  * neither route touches the transcriber, so neither needs faster-whisper
    installed, a model downloaded or a recording to hand over.

Failure codes are shared with /capture on purpose, so a caller has one switch
statement whichever provider answered.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from capture_service.errors import (
    LlmModelNotFound,
    LlmOutputTruncated,
    LlmTimeout,
    LlmUnreachable,
)
from capture_service.parse_cards import validate_extraction_payload
from capture_service.prompt import (
    EXTRACTION_JSON_SCHEMA,
    EXTRACTION_SYSTEM_PROMPT,
    SUMMARY_SYSTEM_PROMPT,
)
from capture_service.schemas import DEFAULT_SLIDE_TITLE
from capture_service.transcribe import MAX_TRANSCRIPT_CHARS
from conftest import (
    SECRET_SPEECH,
    VALID_CARD,
    FakeLlm,
    Service,
    card,
    cards_payload,
    sentinel_wire_chunk,
    wire_card,
    wire_chunk,
)

# Two real component ids, in the shape the browser's model tree produces.
COMPONENTS: list[dict[str, str]] = [
    {"id": "left_cup", "name": "Left Cup", "path": "HP / Left Cup"},
    {"id": "right_cup", "name": "Right Cup", "path": "HP / Right Cup"},
]

POINTING: list[dict[str, Any]] = [
    {
        "userId": "u1",
        "userName": "Alice",
        "partId": "left_cup",
        "partName": "Left Cup",
        "fromMs": 1000,
        "toMs": 5000,
    }
]

HINT: list[dict[str, Any]] = [
    {"speaker": "Alice", "text": "This cup here", "offsetMs": 3000}
]

MINUTES = "## What was reviewed\nThe rear triangle weld.\n\n## Actions\n- [ ] Re-run FEA — Alice"

SECRET = "s" * 32


def summary_card(card_type: str, title: str, **details: Any) -> dict[str, Any]:
    """A wire card of a given type, with `priority` already set."""
    return wire_card(
        type=card_type, title=title, details={"priority": "Medium", **details}
    )


# ─── /extract: the success path ─────────────────────────────────────────────


def test_extract_returns_exactly_the_cards_envelope(service: Service) -> None:
    response = service.post_extract()
    assert response.status_code == 200
    body = response.json()
    # The same rule /capture is held to: no transport metadata, because
    # validateExtractionPayload on the client rejects unknown keys.
    assert set(body) == {"cards"}
    assert len(body["cards"]) == 1


def test_the_client_side_parser_accepts_an_extract_response(service: Service) -> None:
    body = service.post_extract().json()
    cards = validate_extraction_payload(body, now=lambda: 0, new_id=lambda i: f"x{i}")
    assert len(cards) == 1
    assert cards[0].title == VALID_CARD["title"]


def test_extract_never_touches_the_transcriber_or_spools_a_file(
    service: Service,
) -> None:
    # There is no audio in this request, so there is nothing to decode, nothing
    # to spool and nothing to delete. A route that reached for the transcriber
    # would need a Whisper install to answer a text-only job.
    assert service.post_extract().status_code == 200
    assert service.transcriber.paths == []


def test_extract_sends_the_extraction_schema_and_the_extraction_prompt(
    service: Service,
) -> None:
    service.post_extract()
    assert service.llm.last_system_prompt == EXTRACTION_SYSTEM_PROMPT
    # The DEFAULT, not an explicit argument: a card reply that is not
    # schema-constrained is how the details fields got flattened onto the card
    # in the first place.
    assert service.llm.last_schema is EXTRACTION_JSON_SCHEMA


def test_extract_renders_the_transcript_and_context_like_capture(
    service: Service,
) -> None:
    service.post_extract(
        {
            "transcript": [wire_chunk(start_ms=65_000, end_ms=70_000)],
            "context": {
                "agendaIdx": 4,
                "slideTitle": "Rear triangle weld",
                "hoveredPartName": "Bracket",
                "laserTargetPartName": "Seat stay",
            },
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
    assert "c0 [01:05-01:10] speaker-1:" in prompt


def test_the_context_is_optional_and_defaults_like_capture(service: Service) -> None:
    service.post_extract()
    prompt = service.llm.last_user_prompt
    assert prompt.split("\n")[2] == f"Agenda item 0: {DEFAULT_SLIDE_TITLE}"
    assert "hovering" not in prompt
    assert "laser" not in prompt


def test_a_blank_context_value_is_normalised_not_rendered(service: Service) -> None:
    # One rule for both routes: a multipart form field that arrived blank and a
    # JSON string of spaces are the same mistake, and neither may label the
    # prompt with an empty string.
    service.post_extract(
        {
            "context": {
                "agendaIdx": 1,
                "slideTitle": "   ",
                "hoveredPartName": "",
                "laserTargetPartName": "  ",
            }
        }
    )
    prompt = service.llm.last_user_prompt
    assert f"Agenda item 1: {DEFAULT_SLIDE_TITLE}" in prompt
    assert "hovering" not in prompt
    assert "laser" not in prompt


def test_all_three_grounded_sections_reach_the_prompt(service: Service) -> None:
    service.post_extract(
        {
            "componentTree": COMPONENTS,
            "pointingSegments": POINTING,
            "transcriptHint": HINT,
        }
    )
    prompt = service.llm.last_user_prompt
    assert "Components in this model:" in prompt
    assert "left_cup · HP / Left Cup" in prompt
    assert "What people were pointing at:" in prompt
    assert "Alice → Left Cup (1s–5s)" in prompt
    assert "Speaker transcript" in prompt
    assert "[Alice, t=3s] This cup here" in prompt


def test_extract_logs_grounded_counts_not_content(
    service: Service, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG, logger="capture_service"):
        service.post_extract(
            {
                "transcript": [sentinel_wire_chunk()],
                "componentTree": COMPONENTS,
                "pointingSegments": POINTING,
                "transcriptHint": HINT,
            }
        )
    assert "extract: grounded with 2 component(s), 1 pointing segment(s), 1 hint line(s)" in caplog.text
    assert SECRET_SPEECH not in caplog.text


def test_a_card_with_no_speaker_is_attributed_to_the_first_chunk(
    make_service,
) -> None:
    anonymous = dict(VALID_CARD)
    del anonymous["agentId"]
    bundle = make_service(llm=FakeLlm(reply=cards_payload(anonymous)))
    body = bundle.post_extract(
        {"transcript": [wire_chunk(speaker_id="speaker-7")]}
    ).json()
    assert body["cards"][0]["agentId"] == "speaker-7"


# ─── /extract: componentReference filtering (grounded extraction) ───────────


def test_a_listed_component_reference_survives_extract(make_service) -> None:
    bundle = make_service(
        llm=FakeLlm(
            reply=cards_payload(
                card(details={**VALID_CARD["details"], "componentReference": "left_cup"})
            )
        )
    )
    body = bundle.post_extract({"componentTree": COMPONENTS}).json()
    assert body["cards"][0]["details"]["componentReference"] == "left_cup"


def test_an_unlisted_component_reference_is_dropped_but_the_card_survives(
    make_service,
) -> None:
    # The rule /capture already applies, and the reason componentTree is worth
    # sending at all: an id the model invented must not reach the tracker, but
    # the insight itself is still worth keeping.
    bundle = make_service(
        llm=FakeLlm(
            reply=cards_payload(
                card(
                    details={
                        **VALID_CARD["details"],
                        "componentReference": "General Assembly",
                    }
                )
            )
        )
    )
    body = bundle.post_extract({"componentTree": COMPONENTS}).json()
    assert "componentReference" not in body["cards"][0]["details"]
    assert body["cards"][0]["title"] == VALID_CARD["title"]


def test_without_a_component_tree_no_filtering_is_applied(make_service) -> None:
    bundle = make_service(
        llm=FakeLlm(
            reply=cards_payload(
                card(
                    details={
                        **VALID_CARD["details"],
                        "componentReference": "anything goes",
                    }
                )
            )
        )
    )
    body = bundle.post_extract().json()
    assert body["cards"][0]["details"]["componentReference"] == "anything goes"


def test_an_oversized_component_tree_is_capped(service: Service) -> None:
    components = [
        {"id": f"c{i}", "name": f"C{i}", "path": f"C{i}"} for i in range(300)
    ]
    assert service.post_extract({"componentTree": components}).status_code == 200
    prompt = service.llm.last_user_prompt
    assert "c199" in prompt
    assert "c200" not in prompt


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("componentTree", "not json at all"),
        ("componentTree", {"not": "an array"}),
        ("componentTree", ["left_cup", 7]),
        ("componentTree", [{"id": "left_cup"}]),
        ("pointingSegments", "{broken"),
        ("pointingSegments", [{"userId": "u1"}]),
        ("transcriptHint", "[nope"),
        ("transcriptHint", [{"speaker": "Alice", "text": "here"}]),
    ],
)
def test_a_malformed_grounded_field_is_ignored_not_refused(
    service: Service, field: str, value: object
) -> None:
    # /capture's rule, kept: these three are advisory context, and a client
    # that serialised one wrongly must not lose the whole extraction over it.
    response = service.post_extract({field: value})
    assert response.status_code == 200
    assert len(response.json()["cards"]) == 1


def test_well_formed_grounded_entries_survive_next_to_bad_ones(
    service: Service,
) -> None:
    service.post_extract(
        {"componentTree": ["junk", COMPONENTS[0], {"id": 1, "name": "n", "path": "p"}]}
    )
    prompt = service.llm.last_user_prompt
    assert "left_cup · HP / Left Cup" in prompt
    assert "junk" not in prompt


# ─── /extract: request validation ───────────────────────────────────────────


def test_an_empty_transcript_is_a_400(service: Service) -> None:
    response = service.post_extract({"transcript": []})
    assert response.status_code == 400
    # The same code /capture's silent-recording path uses, so the client's
    # existing `case 'empty_transcript'` matches — but 400, not 422: nothing
    # ran and found no speech, the caller sent nothing.
    assert response.json() == {"error": "empty_transcript"}
    assert service.llm.call_count == 0


def test_a_missing_transcript_is_a_400_naming_the_field(service: Service) -> None:
    response = service.client.post("/extract", json={})
    assert response.status_code == 400
    body = response.json()
    assert body["error"] == "invalid_request"
    assert body["fields"] == ["transcript"]


def test_a_malformed_chunk_is_a_400_that_does_not_echo_the_value(
    service: Service,
) -> None:
    response = service.post_extract(
        {
            "transcript": [
                {"speakerId": "speaker-1", "text": SECRET_SPEECH, "startMs": "soon", "endMs": 4200}
            ]
        }
    )
    assert response.status_code == 400
    body = response.json()
    assert body["error"] == "invalid_request"
    assert body["fields"] == ["transcript.0.startMs"]
    # Pydantic's default body quotes `input`. Ours names the field only.
    assert SECRET_SPEECH not in response.text


def test_an_unknown_body_key_is_refused(service: Service) -> None:
    # A JSON body is not a multipart form: there is no legitimate reason for an
    # extra key, and accepting one would let a caller believe a field this
    # service ignores was doing something.
    response = service.post_extract({"roomId": "room-1"})
    assert response.status_code == 400
    assert response.json()["fields"] == ["roomId"]


def test_a_transcript_over_the_prompt_budget_is_a_413(make_service) -> None:
    bundle = make_service()
    response = bundle.post_extract(
        {"transcript": [wire_chunk("x" * (MAX_TRANSCRIPT_CHARS + 1))]}
    )
    assert response.status_code == 413
    assert response.json() == {"error": "transcript_too_large"}
    assert bundle.llm.call_count == 0


def test_a_get_to_extract_is_a_405(service: Service) -> None:
    assert service.client.get("/extract").status_code == 405


# ─── /extract: upstream and parse failures, shared with /capture ────────────

LLM_FAILURES: list[tuple[str, Exception, int, str]] = [
    ("unreachable", LlmUnreachable("no route to host"), 502, "capture_upstream_unreachable"),
    ("timeout", LlmTimeout("timed out"), 504, "capture_upstream_timeout"),
    (
        "model not pulled",
        LlmModelNotFound("model 'qwen2.5:7b' not found"),
        503,
        "capture_model_not_found",
    ),
    ("output truncated", LlmOutputTruncated("ran out of tokens"), 422, "capture_output_truncated"),
]


@pytest.mark.parametrize(
    ("label", "error", "status", "code"), LLM_FAILURES, ids=[e[0] for e in LLM_FAILURES]
)
def test_extract_maps_llm_failures_to_the_codes_capture_uses(
    make_service, label: str, error: Exception, status: int, code: str
) -> None:
    bundle = make_service(llm=FakeLlm(error=error))
    response = bundle.post_extract({"transcript": [sentinel_wire_chunk()]})
    assert response.status_code == status, label
    assert response.json() == {"error": code}, label
    assert SECRET_SPEECH not in response.text, label


@pytest.mark.parametrize(
    ("label", "reply", "expected_body"),
    [
        ("prose", "Nothing worth capturing.", {"error": "capture_parse_error", "reason": "prose"}),
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
    ],
)
def test_extract_maps_unparseable_output_to_the_reason_capture_uses(
    make_service, label: str, reply: str, expected_body: dict[str, Any]
) -> None:
    bundle = make_service(llm=FakeLlm(reply=reply))
    response = bundle.post_extract({"transcript": [sentinel_wire_chunk()]})
    assert response.status_code == 422, label
    assert response.json() == expected_body, label
    # A code, a reason enum and at most a card index — never the reply, which
    # quotes the transcript it was given.
    assert SECRET_SPEECH not in response.text, label


def test_an_extract_failure_never_logs_the_transcript(
    make_service, caplog: pytest.LogCaptureFixture
) -> None:
    bundle = make_service(
        llm=FakeLlm(
            reply=cards_payload(dict(VALID_CARD, type="HAZARD", description=SECRET_SPEECH))
        )
    )
    with caplog.at_level(logging.DEBUG, logger="capture_service"):
        bundle.post_extract({"transcript": [sentinel_wire_chunk()]})
    assert SECRET_SPEECH not in caplog.text


# ─── /summarize: the success path ───────────────────────────────────────────


def test_summarize_returns_exactly_the_summary_envelope(make_service) -> None:
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    response = bundle.post_summarize()
    assert response.status_code == 200
    assert response.json() == {"summary": MINUTES}


def test_summarize_does_not_constrain_the_reply_to_a_schema(make_service) -> None:
    # The asymmetry the `schema` keyword exists for. A markdown answer
    # requested in Ollama's structured-output mode comes back as a card
    # envelope, or as a refusal — either way it is not minutes.
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    bundle.post_summarize()
    assert bundle.llm.last_schema is None
    assert bundle.llm.last_system_prompt == SUMMARY_SYSTEM_PROMPT


def test_extract_does_constrain_its_reply(make_service) -> None:
    bundle = make_service()
    bundle.post_extract()
    assert bundle.llm.last_schema == EXTRACTION_JSON_SCHEMA


def test_the_summary_prompt_lists_cards_before_the_transcript(make_service) -> None:
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    bundle.post_summarize(
        {
            "transcript": [wire_chunk()],
            "cards": [
                summary_card(
                    "RISK",
                    "Bracket weld cracks under load",
                    componentReference="left_cup",
                    impact="Warranty returns",
                )
            ],
            "title": "Rear triangle weld",
        }
    )
    lines = bundle.llm.last_user_prompt.split("\n")
    assert lines[0].startswith("Today's date: ")
    assert lines[2] == "Meeting: Rear triangle weld"
    assert lines[4] == "Insight cards already extracted from this meeting:"
    assert lines[5] == (
        "k0 [RISK] Bracket weld cracks under load: The reviewer said the weld "
        "will crack before the yield target. (component: left_cup; "
        "priority: Medium; impact: Warranty returns)"
    )
    assert lines[7] == "Transcript:"
    assert lines[8] == "c0 [00:00-00:04] speaker-1: The bracket weld will crack under load."


def test_a_blank_title_falls_back_to_a_generic_heading(make_service) -> None:
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    bundle.post_summarize({"title": "   "})
    assert "Meeting: Design review" in bundle.llm.last_user_prompt


def test_cards_are_grouped_the_way_the_minutes_sections_are(make_service) -> None:
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    bundle.post_summarize(
        {
            "transcript": [],
            "cards": [
                summary_card("ACTION", "Re-run the FEA", assignee="Alice"),
                summary_card("RISK", "Weld cracks"),
                summary_card("RATIONALE", "Gusset chosen for stiffness"),
            ],
        }
    )
    card_lines = [
        line for line in bundle.llm.last_user_prompt.split("\n") if line.startswith("k")
    ]
    # k-indices are positional over the SECTION_ORDER sort, not over arrival:
    # the action was sent first and comes out last.
    assert len(card_lines) == 3
    assert card_lines[0].startswith("k0 [RISK] Weld cracks: ")
    assert card_lines[1].startswith("k1 [RATIONALE] Gusset chosen for stiffness: ")
    assert card_lines[2].startswith("k2 [ACTION] Re-run the FEA: ")
    assert card_lines[2].endswith("(assignee: Alice; priority: Medium)")
    assert card_lines[0].endswith("(priority: Medium)")


def test_summarize_from_cards_alone(make_service) -> None:
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    response = bundle.post_summarize(
        {"transcript": [], "cards": [summary_card("RISK", "Weld cracks")]}
    )
    assert response.status_code == 200
    assert "Transcript: none — write the minutes from the cards alone." in (
        bundle.llm.last_user_prompt
    )


def test_summarize_from_a_transcript_alone(make_service) -> None:
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    response = bundle.post_summarize({"transcript": [wire_chunk()], "cards": []})
    assert response.status_code == 200
    assert "Insight cards already extracted from this meeting: none." in (
        bundle.llm.last_user_prompt
    )


def test_summarize_never_touches_the_transcriber(make_service) -> None:
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    assert bundle.post_summarize().status_code == 200
    assert bundle.transcriber.paths == []


# ─── /summarize: request validation ─────────────────────────────────────────


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"transcript": [], "cards": []}, id="both-empty"),
        pytest.param({}, id="both-absent"),
    ],
)
def test_summarizing_nothing_is_a_400(service: Service, body: dict[str, Any]) -> None:
    # Straight through the client, not the helper: post_summarize defaults a
    # missing transcript to one chunk, and "both absent" is exactly the case
    # under test.
    response = service.client.post("/summarize", json=body)
    assert response.status_code == 400
    assert response.json() == {"error": "empty_summary_input"}
    assert service.llm.call_count == 0


def test_a_malformed_card_is_a_400_naming_the_field(service: Service) -> None:
    # InsightCard is extra="forbid" and requires id and timestamp, so a card
    # this service could not have produced is refused here rather than being
    # pasted into a prompt as whatever the caller meant.
    response = service.post_summarize({"cards": [{"type": "RISK", "title": "Weld"}]})
    assert response.status_code == 400
    body = response.json()
    assert body["error"] == "invalid_request"
    assert body["fields"][0].startswith("cards.0.")


def test_an_unknown_key_on_a_card_is_a_400(service: Service) -> None:
    response = service.post_summarize(
        {"cards": [dict(wire_card(), confidence=0.9)]}
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_a_summary_transcript_over_the_budget_is_a_413(make_service) -> None:
    # The ceiling is about the model's context window, not about audio, so it
    # applies to a transcript that arrived as JSON just as it does to one
    # Whisper produced.
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    response = bundle.post_summarize(
        {"transcript": [wire_chunk("x" * (MAX_TRANSCRIPT_CHARS + 1))]}
    )
    assert response.status_code == 413
    assert response.json() == {"error": "transcript_too_large"}
    assert bundle.llm.call_count == 0


# ─── /summarize: upstream failures ─────────────────────────────────────────


@pytest.mark.parametrize(
    ("label", "error", "status", "code"), LLM_FAILURES, ids=[e[0] for e in LLM_FAILURES]
)
def test_summarize_maps_llm_failures_to_their_own_code(
    make_service, label: str, error: Exception, status: int, code: str
) -> None:
    bundle = make_service(llm=FakeLlm(error=error))
    response = bundle.post_summarize({"transcript": [sentinel_wire_chunk()]})
    assert response.status_code == status, label
    assert response.json() == {"error": code}, label
    assert SECRET_SPEECH not in response.text, label


def test_a_summary_failure_never_logs_the_transcript(
    make_service, caplog: pytest.LogCaptureFixture
) -> None:
    bundle = make_service(llm=FakeLlm(error=LlmUnreachable("connection refused")))
    with caplog.at_level(logging.DEBUG, logger="capture_service"):
        bundle.post_summarize({"transcript": [sentinel_wire_chunk()]})
    assert SECRET_SPEECH not in caplog.text


def test_a_successful_summary_logs_counts_not_content(
    make_service, caplog: pytest.LogCaptureFixture
) -> None:
    bundle = make_service(llm=FakeLlm(reply=MINUTES))
    with caplog.at_level(logging.DEBUG, logger="capture_service"):
        bundle.post_summarize({"transcript": [sentinel_wire_chunk()]})
    assert SECRET_SPEECH not in caplog.text
    assert "summarize: 1 chunk(s), 0 card(s) in," in caplog.text
    assert "character(s) of minutes" in caplog.text


# ─── Auth, CORS and the published schema ────────────────────────────────────


@pytest.mark.parametrize("path", ["/extract", "/summarize"])
@pytest.mark.parametrize(
    "headers",
    [
        pytest.param({"X-Capture-Token": SECRET}, id="token-header"),
        pytest.param({"Authorization": f"Bearer {SECRET}"}, id="bearer"),
    ],
)
def test_both_routes_accept_a_configured_secret(
    make_service, path: str, headers: dict[str, str]
) -> None:
    bundle = make_service(env={"CAPTURE_SHARED_SECRET": SECRET})
    response = bundle.client.post(
        path, json={"transcript": [wire_chunk()]}, headers=headers
    )
    assert response.status_code == 200


@pytest.mark.parametrize("path", ["/extract", "/summarize"])
def test_both_routes_require_the_shared_secret_when_one_is_configured(
    make_service, path: str
) -> None:
    # auth.py's rule is one middleware with no exemption list, so a route added
    # later is covered by construction. This is the test that would notice if
    # somebody exempted one.
    bundle = make_service(env={"CAPTURE_SHARED_SECRET": SECRET})
    response = bundle.client.post(path, json={"transcript": [wire_chunk()]})
    assert response.status_code == 401
    assert response.json() == {"error": "unauthorized"}
    assert bundle.llm.call_count == 0


def test_both_routes_work_with_no_secret_configured(service: Service) -> None:
    # The documented laptop default: opt-in by absence, unchanged request path.
    assert service.post_extract().status_code == 200
    assert service.post_summarize().status_code == 200


@pytest.mark.parametrize("path", ["/extract", "/summarize"])
def test_the_cors_configuration_covers_both_routes(
    make_service, path: str
) -> None:
    bundle = make_service(env={"CAPTURE_ALLOWED_ORIGINS": "https://review.example.com"})
    response = bundle.client.options(
        path,
        headers={
            "Origin": "https://review.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.status_code == 200
    assert (
        response.headers["access-control-allow-origin"] == "https://review.example.com"
    )


def test_the_published_summary_response_is_a_single_field(service: Service) -> None:
    schema = service.client.get("/openapi.json").json()
    summary = schema["components"]["schemas"]["SummaryResponse"]
    assert set(summary["properties"]) == {"summary"}
    assert summary["additionalProperties"] is False
    # The error vocabulary is published for both new routes too, so the router
    # does not have to guess what a failure looks like.
    for path in ("/extract", "/summarize"):
        assert "400" in schema["paths"][path]["post"]["responses"]
        assert "413" in schema["paths"][path]["post"]["responses"]
