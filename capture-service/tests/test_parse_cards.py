"""The defensive parser: every malformed shape a model can produce.

Mirrors lib/connectors/capture/__tests__/parseInsightCards.test.ts case for
case, because the guarantee is shared: a model may return ANYTHING, the service
must never crash and never accept a half-built card. A batch is all-or-nothing —
if one card is malformed, none is returned.
"""

from __future__ import annotations

import json
import math
from typing import Any, Callable

import pytest

from capture_service.errors import PARSE_FAILURE_REASONS, CaptureExtractionError
from capture_service.parse_cards import (
    CARD_KEYS,
    DETAILS_KEYS,
    ENVELOPE_KEYS,
    parse_insight_cards,
    validate_extraction_payload,
)
from capture_service.schemas import InsightCard, InsightDetails
from conftest import SECRET_SPEECH, VALID_CARD, card, cards_payload

NOW = 1_700_000_000_000


def parse(
    raw: object,
    *,
    default_agent_id: str | None = "speaker-1",
    now: Callable[[], int] | None = lambda: NOW,
    new_id: Callable[[int], str] | None = None,
    component_ids: set[str] | None = None,
) -> list[InsightCard]:
    return parse_insight_cards(
        raw,
        default_agent_id=default_agent_id,
        now=now,
        new_id=new_id,
        component_ids=component_ids,
    )


def dumped(cards: list[InsightCard]) -> list[dict[str, Any]]:
    """The wire shape: camelCase, and no key at all for an absent optional."""
    return [
        card_.model_dump(by_alias=True, exclude_none=True, mode="json")
        for card_ in cards
    ]


FULL_CARD: dict[str, Any] = {
    "id": "insight-from-the-model",
    "type": "ACTION",
    "agentId": "speaker-2",
    "title": "  Re-run the fatigue simulation  ",
    "description": "  Agreed to re-run it before the next design gate.  ",
    "timestamp": 1_699_999_999_999,
    "relatedPoiId": " bracket-assembly ",
    "sourceMessageIds": [" c1 ", "c2"],
    # Both allowed by CARD_KEYS and both dropped by the parser: a model that
    # claims its card was typed by Maria must not get a hand-made card into the
    # tracker. test_a_full_card_keeps_every_field_it_was_given asserts the drop.
    "source": "manual",
    "createdByName": "Maria Okafor",
    "affectedRequirementIds": ["REQ-12"],
    "kbRecommendations": ["Check ISO 5817 weld class"],
    "details": {
        "priority": "Critical",
        "status": "In Review",
        "assignee": " Dana ",
        "dueDate": "2026-09-30",
        "dueDateText": " by the end of the month ",
        "componentReference": "Bracket",
        "designStage": "DETAILED_DESIGN",
        "decisionRole": "FINAL_DECISION",
        "impact": "Yield drops below target",
        "mitigationStrategy": "Add a gusset",
        "designDriver": "Weight limit",
        "alternativesConsidered": "Aluminium instead of steel",
        "tradeoffAnalysis": "12 g heavier",
        "department": "Simulation",
    },
}


# ─── Happy paths ────────────────────────────────────────────────────────────


def test_a_valid_reply_parses_into_the_typescript_card_shape() -> None:
    cards = parse(cards_payload(VALID_CARD))
    assert dumped(cards) == [
        {
            "id": cards[0].id,
            "type": "RISK",
            "agentId": "speaker-1",
            "title": "Bracket weld cracks under load",
            "description": "The reviewer said the weld will crack before the yield target.",
            "timestamp": NOW,
            "details": {
                "priority": "High",
                "status": "Open",
                "impact": "Warranty returns",
            },
        }
    ]


def test_a_full_card_keeps_every_field_it_was_given() -> None:
    cards = parse(cards_payload(FULL_CARD))
    assert dumped(cards) == [
        {
            "id": "insight-from-the-model",
            "type": "ACTION",
            "agentId": "speaker-2",
            "title": "Re-run the fatigue simulation",
            "description": "Agreed to re-run it before the next design gate.",
            "timestamp": 1_699_999_999_999,
            "relatedPoiId": "bracket-assembly",
            "sourceMessageIds": ["c1", "c2"],
            "affectedRequirementIds": ["REQ-12"],
            "kbRecommendations": ["Check ISO 5817 weld class"],
            "details": {
                "priority": "Critical",
                "status": "In Review",
                "assignee": "Dana",
                "dueDate": "2026-09-30",
                "dueDateText": "by the end of the month",
                "componentReference": "Bracket",
                "designStage": "DETAILED_DESIGN",
                "decisionRole": "FINAL_DECISION",
                "impact": "Yield drops below target",
                "mitigationStrategy": "Add a gusset",
                "designDriver": "Weight limit",
                "alternativesConsidered": "Aluminium instead of steel",
                "tradeoffAnalysis": "12 g heavier",
                "department": "Simulation",
            },
        }
    ]
    # "Keeps every field" has two exceptions, and they are the ones that say who
    # wrote the card. FULL_CARD claims source/createdByName; a card this service
    # parsed was written by a model, so the claim is dropped rather than passed
    # through to the tracker as a hand-made card by somebody who never typed it.
    assert cards[0].source is None
    assert cards[0].created_by_name is None


def test_an_empty_batch_is_a_legal_reply() -> None:
    # The prompt tells the model to return zero cards when the window held
    # nothing worth capturing, so [] is a success, not a failure.
    assert parse('{"cards": []}') == []
    assert parse('{"cards":[]}') == []


def test_card_order_is_preserved() -> None:
    cards = parse(
        cards_payload(
            card(title="First insight"),
            card(type="ACTION", title="Second insight"),
            card(type="RATIONALE", title="Third insight"),
        ),
        new_id=lambda index: f"insight-{index}",
    )
    assert [c.title for c in cards] == [
        "First insight",
        "Second insight",
        "Third insight",
    ]
    assert [c.type.value for c in cards] == ["RISK", "ACTION", "RATIONALE"]


def test_ids_are_minted_per_index_when_the_model_omits_them() -> None:
    cards = parse(
        cards_payload(card(title="A"), card(title="B")),
        new_id=lambda index: f"insight-minted-{index}",
    )
    assert [c.id for c in cards] == ["insight-minted-0", "insight-minted-1"]


def test_the_default_id_mint_produces_the_typescript_id_shape() -> None:
    cards = parse(cards_payload(card()), now=lambda: NOW)
    assert cards[0].id.startswith("insight-")
    # insight-<uuid4>: the same shape parseInsightCards.ts mints.
    assert len(cards[0].id) == len("insight-") + 36
    assert parse(cards_payload(card()))[0].id != cards[0].id


def test_the_clock_is_injectable_and_read_once_for_the_whole_batch() -> None:
    calls: list[int] = []

    def clock() -> int:
        calls.append(1)
        return NOW

    cards = parse(
        cards_payload(card(title="A"), card(title="B"), card(title="C")), now=clock
    )
    assert len(calls) == 1
    assert {c.timestamp for c in cards} == {NOW}


def test_a_supplied_timestamp_wins_over_the_clock() -> None:
    cards = parse(cards_payload(card(timestamp=1_600_000_000_000)))
    assert cards[0].timestamp == 1_600_000_000_000


def test_the_agent_id_fallback_chain_matches_the_typescript_parser() -> None:
    # A card the way the prompt asks for it when the model could not attribute
    # the insight to one speaker: no agentId at all.
    anonymous = dict(VALID_CARD)
    del anonymous["agentId"]

    # 1. the card's own agentId
    assert parse(cards_payload(card(agentId="speaker-9")))[0].agent_id == "speaker-9"
    # 2. the caller's default (the first speaker in the window)
    assert parse(cards_payload(anonymous), default_agent_id="speaker-3")[0].agent_id == "speaker-3"
    # 3. the last-resort label
    assert parse(cards_payload(anonymous), default_agent_id=None)[0].agent_id == "transcript"
    # a blank agentId is "absent", not a value
    assert parse(cards_payload(card(agentId="   ")), default_agent_id="speaker-3")[0].agent_id == "speaker-3"


def test_status_defaults_to_open_and_priority_never_defaults() -> None:
    cards = parse(cards_payload(card(details={"priority": "Low"})))
    assert cards[0].details.status.value == "Open"
    with pytest.raises(CaptureExtractionError) as error:
        parse(cards_payload(card(details={"status": "Open"})))
    assert error.value.reason == "invalid_card"


@pytest.mark.parametrize(
    "priority", ["Critical", "High", "Medium", "Low"]
)
def test_every_priority_is_accepted(priority: str) -> None:
    cards = parse(cards_payload(card(details={"priority": priority})))
    assert cards[0].details.priority.value == priority


@pytest.mark.parametrize(
    "status", ["Open", "In Review", "Approved", "Rejected"]
)
def test_every_status_is_accepted(status: str) -> None:
    cards = parse(cards_payload(card(details={"priority": "Low", "status": status})))
    assert cards[0].details.status.value == status


@pytest.mark.parametrize("insight_type", ["RISK", "RATIONALE", "ACTION"])
def test_every_insight_type_is_accepted(insight_type: str) -> None:
    assert parse(cards_payload(card(type=insight_type)))[0].type.value == insight_type


@pytest.mark.parametrize(
    "decision_role",
    ["TRIGGER", "RATIONALE", "INTERMEDIATE_DECISION", "FINAL_DECISION"],
)
def test_every_decision_role_is_accepted(decision_role: str) -> None:
    cards = parse(
        cards_payload(card(details={"priority": "Low", "decisionRole": decision_role}))
    )
    assert cards[0].details.decision_role.value == decision_role


@pytest.mark.parametrize("design_stage", ["DETAILED_DESIGN"])
def test_every_design_stage_is_accepted(design_stage: str) -> None:
    cards = parse(
        cards_payload(card(details={"priority": "Low", "designStage": design_stage}))
    )
    assert cards[0].details.design_stage.value == design_stage


def test_absent_optional_fields_do_not_appear_as_null_keys() -> None:
    # The TypeScript parser only sets a key when the model supplied one, and
    # validateExtractionPayload rejects unknown keys — so a card must not carry
    # `relatedPoiId: null` across the wire either.
    payload = dumped(parse(cards_payload(VALID_CARD)))[0]
    assert "relatedPoiId" not in payload
    assert "sourceMessageIds" not in payload
    assert "affectedRequirementIds" not in payload
    assert "kbRecommendations" not in payload
    assert "assignee" not in payload["details"]
    assert "decisionRole" not in payload["details"]


def test_a_null_optional_field_is_treated_as_absent() -> None:
    payload = dumped(parse(cards_payload(card(relatedPoiId=None, sourceMessageIds=None))))[0]
    assert "relatedPoiId" not in payload
    assert "sourceMessageIds" not in payload


def test_a_null_status_falls_back_to_open() -> None:
    cards = parse(cards_payload(card(details={"priority": "Low", "status": None})))
    assert cards[0].details.status.value == "Open"


# ─── Markdown fences ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "wrapper",
    [
        ("```", "```"),
        ("```json", "```"),
        ("```JSON", "```"),
        ("~~~", "~~~"),
        ("   ```   ", "   ```"),  # indented, as a model often emits
    ],
)
def test_a_closed_fence_is_unwrapped_and_parsed(wrapper: tuple[str, str]) -> None:
    opening, closing = wrapper
    raw = f"{opening}\n{cards_payload(VALID_CARD)}\n{closing}"
    assert len(parse(raw)) == 1


def test_a_closed_fence_with_blank_padding_is_unwrapped() -> None:
    raw = f"  \n```json\n{cards_payload(VALID_CARD)}\n```\n  "
    assert len(parse(raw)) == 1


def test_an_unclosed_fence_is_rejected_not_guessed_at() -> None:
    raw = f"```json\n{cards_payload(VALID_CARD)}"
    with pytest.raises(CaptureExtractionError) as error:
        parse(raw)
    assert error.value.reason == "markdown_fenced"


def test_a_single_line_fence_is_rejected() -> None:
    # One line, starting with a fence, so there is nothing that could close it.
    with pytest.raises(CaptureExtractionError) as error:
        parse(f"``` {cards_payload(VALID_CARD)}")
    assert error.value.reason == "markdown_fenced"


def test_a_closed_fence_around_nothing_is_an_empty_response() -> None:
    with pytest.raises(CaptureExtractionError) as error:
        parse("```\n```")
    assert error.value.reason == "prose"


def test_a_closed_fence_around_prose_is_prose() -> None:
    with pytest.raises(CaptureExtractionError) as error:
        parse("```\nI could not find any risks in this meeting.\n```")
    assert error.value.reason == "prose"


# ─── Every rejection, with the reason the TypeScript parser would give ──────

REJECTIONS: list[tuple[str, object, str, int | None]] = [
    # ── not text at all
    ("no content", None, "malformed_json", None),
    ("a number instead of text", 42, "malformed_json", None),
    ("an already-parsed dict", {"cards": []}, "malformed_json", None),
    ("a list instead of text", ["cards"], "malformed_json", None),
    ("bytes instead of text", b'{"cards": []}', "malformed_json", None),
    # ── prose
    ("empty string", "", "prose", None),
    ("whitespace only", "   \n\t ", "prose", None),
    ("a polite refusal", "Sorry, I cannot extract insights from that transcript.", "prose", None),
    ("prose then json", "Here you go:\n" + cards_payload(VALID_CARD), "prose", None),
    # Trailing prose: the reply STARTS as JSON and does not end with the
    # matching bracket, which is exactly what a truncated completion looks like.
    ("json then prose", cards_payload(VALID_CARD) + "\nHope that helps!", "truncated_json", None),
    # ── truncated
    ("object cut off mid-value", '{"cards": [{"type": "RISK", "tit', "truncated_json", None),
    ("array cut off", '[{"type": "RISK"}', "truncated_json", None),
    ("cut off inside a string value", '{"cards": [{"type": "RISK", "title": "the weld', "truncated_json", None),
    # ── malformed
    ("closing bracket does not match the opening one", '{"cards": []]', "truncated_json", None),
    # Starts { and ends }, so it is NOT classified as truncated — it is JSON
    # that simply does not parse.
    ("trailing comma", '{"cards": [],}', "malformed_json", None),
    ("single quotes", "{'cards': []}", "malformed_json", None),
    ("unquoted key", '{cards: []}', "malformed_json", None),
    # ── JSON constants Python would accept and JSON.parse would not
    ("bare NaN", "NaN", "prose", None),
    ("bare Infinity", "Infinity", "prose", None),
    ("bare -Infinity", "-Infinity", "prose", None),
    ("NaN inside the envelope", '{"cards": NaN}', "malformed_json", None),
    # ── wrong envelope
    ("a bare array", json.dumps([VALID_CARD]), "wrong_envelope", None),
    ("a bare JSON string", json.dumps("cards"), "wrong_envelope", None),
    ("a bare JSON number", "42", "wrong_envelope", None),
    ("a bare JSON true", "true", "wrong_envelope", None),
    ("a bare JSON null", "null", "wrong_envelope", None),
    ("an empty object", "{}", "wrong_envelope", None),
    ("the envelope renamed to insights", '{"insights": []}', "wrong_envelope", None),
    ("cards as an object", '{"cards": {"0": {}}}', "wrong_envelope", None),
    ("cards as a string", '{"cards": "none"}', "wrong_envelope", None),
    ("cards missing entirely", '{"provider": "ollama"}', "wrong_envelope", None),
    # ── envelope carrying extra keys
    ("transport metadata added to the envelope", '{"cards": [], "tookMs": 4200}', "extra_fields", None),
    # ── card level
    ("a card that is a string", '{"cards": ["a risk"]}', "invalid_card", 0),
    ("a card that is null", '{"cards": [null]}', "invalid_card", 0),
    ("a card that is an array", '{"cards": [[]]}', "invalid_card", 0),
    ("an invented card field", cards_payload(card(confidence=0.9)), "extra_fields", 0),
    ("a snake_case card field", cards_payload(card(agent_id="speaker-1")), "extra_fields", 0),
    ("type missing", cards_payload({k: v for k, v in VALID_CARD.items() if k != "type"}), "invalid_card", 0),
    ("type not in the enum", cards_payload(card(type="HAZARD")), "invalid_card", 0),
    ("type in the wrong case", cards_payload(card(type="risk")), "invalid_card", 0),
    ("type not a string", cards_payload(card(type=3)), "invalid_card", 0),
    ("details missing", cards_payload({k: v for k, v in VALID_CARD.items() if k != "details"}), "invalid_card", 0),
    ("details null", cards_payload(card(details=None)), "invalid_card", 0),
    ("details a string", cards_payload(card(details="high priority")), "invalid_card", 0),
    ("an invented details field", cards_payload(card(details={"severity": "high"})), "extra_fields", 0),
    ("priority missing", cards_payload(card(details={"status": "Open"})), "invalid_card", 0),
    ("priority invented", cards_payload(card(details={"priority": "Urgent"})), "invalid_card", 0),
    ("priority not a string", cards_payload(card(details={"priority": 3})), "invalid_card", 0),
    ("status invented", cards_payload(card(details={"priority": "Low", "status": "Triage"})), "invalid_card", 0),
    ("decisionRole invented", cards_payload(card(details={"priority": "Low", "decisionRole": "DECISION"})), "invalid_card", 0),
    ("designStage invented", cards_payload(card(details={"priority": "Low", "designStage": "CONCEPT"})), "invalid_card", 0),
    ("title missing", cards_payload({k: v for k, v in VALID_CARD.items() if k != "title"}), "invalid_card", 0),
    ("title empty", cards_payload(card(title="")), "invalid_card", 0),
    ("title whitespace", cards_payload(card(title="   ")), "invalid_card", 0),
    ("title a number", cards_payload(card(title=17)), "invalid_card", 0),
    ("description missing", cards_payload({k: v for k, v in VALID_CARD.items() if k != "description"}), "invalid_card", 0),
    ("description empty", cards_payload(card(description="")), "invalid_card", 0),
    ("id not a string", cards_payload(card(id=12)), "invalid_card", 0),
    ("id an array", cards_payload(card(id=["a"])), "invalid_card", 0),
    ("agentId not a string", cards_payload(card(agentId=7)), "invalid_card", 0),
    ("relatedPoiId an array", cards_payload(card(relatedPoiId=["bracket"])), "invalid_card", 0),
    ("timestamp a string", cards_payload(card(timestamp="1700000000000")), "invalid_card", 0),
    ("timestamp a boolean", cards_payload(card(timestamp=True)), "invalid_card", 0),
    ("timestamp null-ish object", cards_payload(card(timestamp={})), "invalid_card", 0),
    ("sourceMessageIds not an array", cards_payload(card(sourceMessageIds="c1")), "invalid_card", 0),
    ("sourceMessageIds with an empty string", cards_payload(card(sourceMessageIds=["c1", "  "])), "invalid_card", 0),
    ("sourceMessageIds with a number", cards_payload(card(sourceMessageIds=["c1", 2])), "invalid_card", 0),
    ("kbRecommendations not an array", cards_payload(card(kbRecommendations={})), "invalid_card", 0),
    ("affectedRequirementIds with null", cards_payload(card(affectedRequirementIds=[None])), "invalid_card", 0),
    ("assignee not a string", cards_payload(card(details={"priority": "Low", "assignee": 3})), "invalid_card", 0),
]


@pytest.mark.parametrize(
    ("label", "raw", "reason", "card_index"),
    REJECTIONS,
    ids=[entry[0] for entry in REJECTIONS],
)
def test_rejected_with_the_reason_the_typescript_parser_gives(
    label: str, raw: object, reason: str, card_index: int | None
) -> None:
    with pytest.raises(CaptureExtractionError) as error:
        parse(raw, default_agent_id="speaker-1")
    assert error.value.reason == reason, label
    assert error.value.card_index == card_index, label
    assert error.value.status == 422
    assert error.value.code == "capture_parse_error"


def test_every_reason_used_by_the_suite_is_in_the_closed_vocabulary() -> None:
    reasons = {entry[2] for entry in REJECTIONS}
    assert reasons <= PARSE_FAILURE_REASONS
    # And every reason in the vocabulary is actually reachable somewhere in this
    # suite, so none of them is dead code that has quietly diverged from the
    # TypeScript parser. (markdown_fenced is covered by the fence tests above.)
    assert reasons | {"markdown_fenced"} == PARSE_FAILURE_REASONS


# ─── All-or-nothing ─────────────────────────────────────────────────────────


def test_one_bad_card_rejects_the_whole_batch() -> None:
    raw = cards_payload(
        card(title="Good card"),
        card(title="Also good"),
        card(title="Bad", type="HAZARD"),
    )
    with pytest.raises(CaptureExtractionError) as error:
        parse(raw)
    assert error.value.card_index == 2


def test_the_failure_index_points_at_the_card_that_failed() -> None:
    raw = cards_payload(card(), card(), card(), card(details={"priority": "Nope"}))
    with pytest.raises(CaptureExtractionError) as error:
        parse(raw)
    assert error.value.card_index == 3
    assert error.value.reason == "invalid_card"


def test_a_partial_list_is_never_returned() -> None:
    # The function either returns every card or raises: there is no code path
    # that yields the good prefix, which is what would let a half-built batch
    # reach the Manager workspace.
    with pytest.raises(CaptureExtractionError):
        parse(cards_payload(card(), card(details={})))


# ─── Value-level entry point ────────────────────────────────────────────────


def test_an_already_parsed_payload_can_be_validated_directly() -> None:
    cards = validate_extraction_payload(
        {"cards": [VALID_CARD]},
        default_agent_id="speaker-1",
        now=lambda: NOW,
        new_id=lambda index: f"insight-{index}",
    )
    assert [c.id for c in cards] == ["insight-0"]
    assert cards[0].timestamp == NOW


def test_a_nan_timestamp_is_rejected_at_the_value_level() -> None:
    # json.loads would never produce this (parse_constant refuses it), but the
    # value-level entry point can be handed one by Python code, and JSON.parse
    # has no NaN to compare against — so it is checked explicitly.
    with pytest.raises(CaptureExtractionError) as error:
        validate_extraction_payload({"cards": [card(timestamp=math.nan)]})
    assert error.value.reason == "invalid_card"


def test_an_infinite_timestamp_is_rejected_at_the_value_level() -> None:
    with pytest.raises(CaptureExtractionError) as error:
        validate_extraction_payload({"cards": [card(timestamp=math.inf)]})
    assert error.value.reason == "invalid_card"


def test_a_negative_zero_timestamp_is_still_a_number() -> None:
    cards = validate_extraction_payload(
        {"cards": [card(timestamp=0)]}, now=lambda: NOW
    )
    assert cards[0].timestamp == 0


# ─── Allowlists agree with the TypeScript shape ─────────────────────────────


def wire_names(model: type[InsightCard]) -> list[str]:
    """The camelCase name each field of a model goes over the wire as."""
    return [field.alias or name for name, field in model.model_fields.items()]


def test_the_key_allowlists_are_exactly_the_wire_shapes() -> None:
    # CARD_KEYS / DETAILS_KEYS are the allowlists the parser rejects against;
    # the models are what it builds. If those two ever disagree, the parser
    # would reject a card it just made.
    assert ENVELOPE_KEYS == frozenset({"cards"})
    assert CARD_KEYS == frozenset(wire_names(InsightCard))
    assert DETAILS_KEYS == frozenset(wire_names(InsightDetails))


def test_the_full_card_exercises_every_allowed_key() -> None:
    # A key that is allowed but never exercised is a key nobody has tested.
    assert set(FULL_CARD) == set(CARD_KEYS)
    assert set(FULL_CARD["details"]) == set(DETAILS_KEYS)


# ─── Nothing sensitive escapes in an error ──────────────────────────────────


def bad_replies_containing_transcript_text() -> list[tuple[str, object]]:
    return [
        ("prose quoting the meeting", f"I heard someone say {SECRET_SPEECH}, so here you go."),
        ("truncated json quoting it", '{"cards": [{"title": "' + SECRET_SPEECH),
        ("malformed json quoting it", '{"cards": [{"title": ' + SECRET_SPEECH + "}]}"),
        ("unclosed fence quoting it", f"```json\n{{\"cards\": [{{\"title\": \"{SECRET_SPEECH}\"}}"),
        (
            "an invented field whose VALUE is transcript text",
            cards_payload(card(**{"noteAboutTheMeeting": SECRET_SPEECH})),
        ),
        (
            "an invented field whose NAME is transcript text",
            '{"cards": [{"type": "RISK", "title": "t", "description": "d", '
            f'"details": {{"priority": "Low"}}, "{SECRET_SPEECH}": 1}}]',
        ),
        ("a bad enum value that is transcript text", cards_payload(card(details={"priority": SECRET_SPEECH}))),
        ("an empty description next to real text", cards_payload(card(description=""))),
        ("wrong envelope quoting it", f'{{"{SECRET_SPEECH}": []}}'),
    ]


@pytest.mark.parametrize(
    "raw",
    [entry[1] for entry in bad_replies_containing_transcript_text()],
    ids=[entry[0] for entry in bad_replies_containing_transcript_text()],
)
def test_no_error_message_or_response_quotes_model_output(raw: object) -> None:
    with pytest.raises(CaptureExtractionError) as error:
        parse(raw)
    message = str(error.value)
    assert SECRET_SPEECH not in message
    # The response body is what the client sees: a code, a reason enum and at
    # most a card index.
    body = error.value.response_body()
    assert body["error"] == "capture_parse_error"
    assert set(body) <= {"error", "reason", "cardIndex"}
    assert SECRET_SPEECH not in json.dumps(body)


def test_an_identifier_shaped_invented_field_is_named_in_the_message() -> None:
    # Naming the invented field is the whole diagnostic for the realistic
    # failure (a model adding "confidence"), so it is kept.
    with pytest.raises(CaptureExtractionError) as error:
        parse(cards_payload(card(confidence=0.9)))
    assert "confidence" in str(error.value)


def test_a_prose_shaped_invented_field_is_not_named_in_the_message() -> None:
    with pytest.raises(CaptureExtractionError) as error:
        parse(cards_payload(card(**{"the weld will crack at 40 degrees": 1})))
    assert error.value.reason == "extra_fields"
    assert "weld" not in str(error.value)
    assert "unprintable key name" in str(error.value)


def test_the_response_body_reports_the_card_index() -> None:
    with pytest.raises(CaptureExtractionError) as error:
        parse(cards_payload(card(), card(type="NOPE")))
    assert error.value.response_body() == {
        "error": "capture_parse_error",
        "reason": "invalid_card",
        "cardIndex": 1,
    }


def test_the_response_body_omits_the_index_for_a_whole_reply_failure() -> None:
    with pytest.raises(CaptureExtractionError) as error:
        parse("no json here at all")
    assert error.value.response_body() == {
        "error": "capture_parse_error",
        "reason": "prose",
    }


# ─── componentReference validation (grounded capture) ──────────────────────


def test_a_listed_component_reference_is_kept() -> None:
    payload = card(
        details={**VALID_CARD["details"], "componentReference": "left_cup"}
    )
    cards = parse(cards_payload(payload), component_ids={"left_cup", "right_cup"})
    assert cards[0].details.component_reference == "left_cup"


def test_an_unlisted_component_reference_is_dropped_but_the_card_survives() -> None:
    payload = card(
        details={**VALID_CARD["details"], "componentReference": "General Assembly"}
    )
    cards = parse(cards_payload(payload), component_ids={"left_cup", "right_cup"})
    assert cards[0].details.component_reference is None
    assert cards[0].title == VALID_CARD["title"]


def test_no_component_ids_means_no_filtering() -> None:
    payload = card(
        details={**VALID_CARD["details"], "componentReference": "anything goes"}
    )
    cards = parse(cards_payload(payload))
    assert cards[0].details.component_reference == "anything goes"


def test_component_ids_none_also_means_no_filtering() -> None:
    payload = card(
        details={**VALID_CARD["details"], "componentReference": "anything goes"}
    )
    cards = parse(cards_payload(payload), component_ids=None)
    assert cards[0].details.component_reference == "anything goes"
