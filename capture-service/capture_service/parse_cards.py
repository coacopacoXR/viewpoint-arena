"""Defensive parser for model-produced InsightCard payloads.

A line-by-line port of lib/connectors/capture/parseInsightCards.ts, which is
the authority on this contract: the same allowlists, the same failure reasons,
the same order of checks, so a reply that the TypeScript parser accepts this
one accepts, and a reply it rejects is rejected here for the same reason. Both
implementations are pinned to the TypeScript source by
tests/test_typescript_parity.py.

The rule this module exists to enforce is unchanged: a model may return
ANYTHING, and the service must never crash and never accept a half-built card.
Parsing a batch is all-or-nothing — if cards[7] is malformed, none of the eight
is returned.

Two deliberate divergences from the TypeScript original, both because this
message text is written to the service log:

  1. No message quotes model output. The TypeScript parser embeds a 120-char
     snippet of the reply, which quotes the transcript; that is safe there only
     because api/capture/extract.ts forwards `reason` and never `message`.
     Here the message itself carries no content, so no call site has to
     remember the rule.
  2. Unknown JSON key names are echoed only when they are identifier-shaped
     (`_safe_key_names`). A realistic failure is the model inventing
     "confidence"; a key holding prose would be transcript text, and this
     module does not launder either into a log line.

Python/JSON differences from JSON.parse that are handled explicitly:
`json.loads` accepts the bare constants NaN, Infinity and -Infinity, which
JSON.parse rejects, so `parse_constant` refuses them and the input is
classified the same way the TypeScript parser would classify it.
"""

from __future__ import annotations

import json
import math
import re
import time
import uuid
from typing import Callable, Final

from pydantic import ValidationError

from .errors import CaptureExtractionError
from .schemas import (
    DecisionRole,
    DesignStage,
    InsightCard,
    InsightDetails,
    InsightType,
    Priority,
    Status,
)

# Allowlists derived from the enums in schemas.py, which are themselves pinned
# to the TypeScript unions, so a value can never be legal in one place and
# illegal in another.
INSIGHT_TYPES: Final[tuple[str, ...]] = tuple(member.value for member in InsightType)
PRIORITIES: Final[tuple[str, ...]] = tuple(member.value for member in Priority)
STATUSES: Final[tuple[str, ...]] = tuple(member.value for member in Status)
DECISION_ROLES: Final[tuple[str, ...]] = tuple(member.value for member in DecisionRole)
DESIGN_STAGES: Final[tuple[str, ...]] = tuple(member.value for member in DesignStage)

# Allowlists, not denylists: a field the model invents is rejected rather than
# silently passed through into the tracker. These are exactly the keys of
# InsightCard and InsightDetails in types.ts.
#
# "source" and "createdByName" are listed but never copied onto a card (see
# _validate_card): they say who wrote a card, and a card this parser produced was
# written by a model, so it is an AI card whatever it claims. Listing them keeps
# the set equal to the TypeScript interface, which tests/test_typescript_parity.py
# checks, while a model that echoes them back is tolerated rather than trusted.
ENVELOPE_KEYS: Final[frozenset[str]] = frozenset({"cards"})
CARD_KEYS: Final[frozenset[str]] = frozenset(
    {
        "id",
        "type",
        "agentId",
        "title",
        "description",
        "timestamp",
        "relatedPoiId",
        "sourceMessageIds",
        "details",
        "source",
        "createdByName",
        "affectedRequirementIds",
        "kbRecommendations",
    }
)
DETAILS_KEYS: Final[frozenset[str]] = frozenset(
    {
        "priority",
        "status",
        "assignee",
        "dueDate",
        "dueDateText",
        "componentReference",
        "designStage",
        "decisionRole",
        "impact",
        "mitigationStrategy",
        "designDriver",
        "alternativesConsidered",
        "tradeoffAnalysis",
        "department",
    }
)

# The InsightDetails fields that are plain optional strings. Listed rather than
# derived so a new enum-valued field cannot be swept into the wrong validator.
STRING_DETAIL_KEYS: Final[tuple[str, ...]] = (
    "assignee",
    "dueDate",
    "dueDateText",
    "componentReference",
    "impact",
    "mitigationStrategy",
    "designDriver",
    "alternativesConsidered",
    "tradeoffAnalysis",
    "department",
)
ARRAY_CARD_KEYS: Final[tuple[str, ...]] = (
    "sourceMessageIds",
    "affectedRequirementIds",
    "kbRecommendations",
)

DEFAULT_AGENT_ID = "transcript"

_FENCE_UNCLOSED = (
    "The model opened a markdown code fence but never closed it, so the reply "
    "is incomplete — usually the completion hit its output-token limit. "
    "Nothing is returned: an unclosed fence means unclosed JSON."
)

# Distinguishes "the key is absent" from "the key is present and null", which
# JSON.parse/TypeScript get for free as undefined vs null.
_MISSING = object()


# ─── Text-level entry point (model output as it came off the wire) ──────────


def parse_insight_cards(
    raw_model_output: object,
    *,
    default_agent_id: str | None = None,
    now: Callable[[], int] | None = None,
    new_id: Callable[[int], str] | None = None,
    component_ids: set[str] | None = None,
) -> list[InsightCard]:
    """Parse raw model output into InsightCard[].

    @param default_agent_id Used when a card omits `agentId`. Callers pass the
           first speaker in the transcript, as the TypeScript providers do.
    @param now Injectable clock returning epoch milliseconds, for deterministic
           tests.
    @param new_id Injectable id mint, for deterministic tests.
    @param component_ids When supplied (a grounded capture), a
           componentReference that is not in this set is dropped from the card
           rather than passing an unvalidated part name to the tracker. When
           None, no filtering is applied (pre-section-D behaviour).

    @raises CaptureExtractionError for every shape of bad output. Never raises
            anything else, and never returns a partial list.
    """
    if not isinstance(raw_model_output, str):
        raise CaptureExtractionError(
            "malformed_json",
            "The model returned no text content to parse.",
        )

    text = raw_model_output.strip()

    # Unwrap a markdown code fence before parsing.
    #
    # Ollama is called with format:"json", which makes fences unreachable in
    # the normal path, but a model that ignores the format instruction — or an
    # operator who points this service at a different LLM server — will produce
    # them. Unwrapping is not guesswork: only the fence delimiters are removed,
    # and json.loads still validates everything inside. An opening fence that
    # is never closed means the reply was cut off, and that is rejected.
    lines = re.split(r"\r?\n", text)
    if len(lines) > 1 and _is_fence(lines[0]):
        if _is_fence(lines[-1]):
            text = "\n".join(lines[1:-1]).strip()
        else:
            raise CaptureExtractionError("markdown_fenced", _FENCE_UNCLOSED)
    elif _is_fence(text):
        raise CaptureExtractionError("markdown_fenced", _FENCE_UNCLOSED)

    if not text:
        raise CaptureExtractionError(
            "prose", "The model returned an empty response."
        )

    try:
        parsed = json.loads(text, parse_constant=_reject_json_constant)
    except ValueError:
        # from None: a JSONDecodeError's context is not needed, and suppressing
        # the chain keeps any document text out of a logged traceback.
        raise _classify_unparseable(text) from None

    return validate_extraction_payload(
        parsed,
        default_agent_id=default_agent_id,
        now=now,
        new_id=new_id,
        component_ids=component_ids,
    )


def _is_fence(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("```") or stripped.startswith("~~~")


def _reject_json_constant(constant: str) -> float:
    # json.loads calls this for NaN / Infinity / -Infinity, which JSON.parse
    # rejects outright. Raising keeps the two parsers in agreement.
    raise ValueError(f"{constant} is not valid JSON")


def _classify_unparseable(text: str) -> CaptureExtractionError:
    """Why did valid-looking text fail to parse?

    The distinction matters to an operator: truncation means raise the output
    token limit, prose means the model ignored the format instruction.
    """
    first = text[0]
    last = text[-1]

    if first not in "{[":
        return CaptureExtractionError(
            "prose",
            "The model replied in natural language instead of JSON. The reply "
            "is not quoted here because it would carry transcript content.",
        )

    closes_properly = (first == "{" and last == "}") or (first == "[" and last == "]")
    if not closes_properly:
        return CaptureExtractionError(
            "truncated_json",
            "The model output was cut off mid-JSON — usually the completion hit "
            "its output-token limit. Raise the limit or shorten the transcript.",
        )

    return CaptureExtractionError(
        "malformed_json",
        "The model returned JSON that does not parse.",
    )


# ─── Value-level entry point (already-parsed JSON) ──────────────────────────


def validate_extraction_payload(
    payload: object,
    *,
    default_agent_id: str | None = None,
    now: Callable[[], int] | None = None,
    new_id: Callable[[int], str] | None = None,
    component_ids: set[str] | None = None,
) -> list[InsightCard]:
    """Validate the `{ "cards": [...] }` envelope and every card in it.

    Kept separate from parse_insight_cards for the same reason the TypeScript
    parser exports validateExtractionPayload: it is the value-level entry point
    for a payload that arrived already parsed.
    """
    if not isinstance(payload, dict):
        raise CaptureExtractionError(
            "wrong_envelope",
            "Expected a JSON object with a \"cards\" array, got "
            + ("a bare array." if isinstance(payload, list) else f"{_describe(payload)}."),
        )

    # "cards" is checked before the unknown-key sweep so that a model which
    # renamed the envelope ({"insights": [...]}) is told the envelope is wrong,
    # rather than being told it added a field.
    cards = _get(payload, "cards")
    if not isinstance(cards, list):
        raise CaptureExtractionError(
            "wrong_envelope",
            f'"cards" must be an array, got {_describe(cards)}. Expected the '
            f"shape {{ \"cards\": [ ... ] }} described in the extraction prompt.",
        )

    _reject_unknown_keys(payload, ENVELOPE_KEYS, "response")

    # Resolved once for the whole batch, so every card minted from one reply
    # shares a timestamp — and so a test can pin both.
    now_ms = (now or _epoch_ms)()
    mint_id = new_id or _default_new_id

    return [
        _validate_card(
            raw,
            index,
            default_agent_id=default_agent_id,
            now_ms=now_ms,
            mint_id=mint_id,
            component_ids=component_ids,
        )
        for index, raw in enumerate(cards)
    ]


def _validate_card(
    raw: object,
    index: int,
    *,
    default_agent_id: str | None,
    now_ms: int,
    mint_id: Callable[[int], str],
    component_ids: set[str] | None = None,
) -> InsightCard:
    where = f"cards[{index}]"
    if not isinstance(raw, dict):
        raise CaptureExtractionError(
            "invalid_card",
            f"{where} must be an object, got {_describe(raw)}.",
            index,
        )
    _reject_unknown_keys(raw, CARD_KEYS, where, index)

    card_type = _one_of(raw, "type", INSIGHT_TYPES, where, index)
    details = _validate_details(
        _get(raw, "details"), index, f"{where}.details", component_ids=component_ids
    )

    card_id = _optional_non_empty_string(raw, "id", where, index)
    agent_id = _optional_non_empty_string(raw, "agentId", where, index)

    card: dict[str, object] = {
        "id": mint_id(index) if card_id is None else card_id,
        "type": card_type,
        "agentId": agent_id or default_agent_id or DEFAULT_AGENT_ID,
        "title": _required_non_empty_string(raw, "title", where, index),
        "description": _required_non_empty_string(raw, "description", where, index),
        "timestamp": _optional_timestamp(raw, index, where, now_ms),
        "details": details,
    }

    # Optional fields are only set when the model actually supplied them, so a
    # card never carries null-valued keys into the tracker.
    related_poi_id = _optional_non_empty_string(raw, "relatedPoiId", where, index)
    if related_poi_id is not None:
        card["relatedPoiId"] = related_poi_id

    for key in ARRAY_CARD_KEYS:
        value = _optional_string_array(raw, key, where, index)
        if value is not None:
            card[key] = value

    return _build(InsightCard, card, where, index)


def _validate_details(
    raw: object,
    card_index: int,
    where: str,
    *,
    component_ids: set[str] | None = None,
) -> InsightDetails:
    if not isinstance(raw, dict):
        raise CaptureExtractionError(
            "invalid_card",
            f"{where} must be an object, got {_describe(raw)}.",
            card_index,
        )
    _reject_unknown_keys(raw, DETAILS_KEYS, where, card_index)

    # priority is required: the Manager workspace triages on it, and guessing a
    # priority would be inventing an engineering judgement the model did not
    # make. status defaults to Open, which is what a freshly extracted card is.
    status = _optional_one_of(raw, "status", STATUSES, where, card_index)
    details: dict[str, object] = {
        "priority": _one_of(raw, "priority", PRIORITIES, where, card_index),
        "status": Status.OPEN.value if status is None else status,
    }

    for key in STRING_DETAIL_KEYS:
        value = _optional_non_empty_string(raw, key, where, card_index)
        if value is not None:
            # When a grounded component list was supplied, a componentReference
            # that is not in it is dropped (the card survives, the field does
            # not). Without a list, every non-empty string passes through.
            if key == "componentReference" and component_ids is not None:
                if value not in component_ids:
                    continue
            details[key] = value

    design_stage = _optional_one_of(raw, "designStage", DESIGN_STAGES, where, card_index)
    if design_stage is not None:
        details["designStage"] = design_stage

    decision_role = _optional_one_of(
        raw, "decisionRole", DECISION_ROLES, where, card_index
    )
    if decision_role is not None:
        details["decisionRole"] = decision_role

    return _build(InsightDetails, details, where, card_index)


# ─── Field validators ───────────────────────────────────────────────────────


def _get(obj: dict[str, object], key: str) -> object:
    return obj.get(key, _MISSING)


def _reject_unknown_keys(
    obj: dict[str, object],
    allowed: frozenset[str],
    where: str,
    card_index: int | None = None,
) -> None:
    unknown = [key for key in obj if key not in allowed]
    if not unknown:
        return
    raise CaptureExtractionError(
        "extra_fields",
        f"{where} contained field(s) that are not part of the InsightCard "
        f"shape: {_safe_key_names(unknown)}. Refusing the card rather than "
        f"passing an unknown field through to the tracker.",
        card_index,
    )


def _required_non_empty_string(
    obj: dict[str, object], key: str, where: str, card_index: int
) -> str:
    value = _get(obj, key)
    if not isinstance(value, str) or not value.strip():
        raise CaptureExtractionError(
            "invalid_card",
            f"{where}.{key} must be a non-empty string, got {_describe(value)}.",
            card_index,
        )
    return value.strip()


def _optional_non_empty_string(
    obj: dict[str, object], key: str, where: str, card_index: int
) -> str | None:
    """Optional string; an empty or whitespace-only value counts as absent."""
    value = _get(obj, key)
    if value is _MISSING or value is None:
        return None
    if not isinstance(value, str):
        raise CaptureExtractionError(
            "invalid_card",
            f"{where}.{key} must be a string when present, got {_describe(value)}.",
            card_index,
        )
    trimmed = value.strip()
    return trimmed or None


def _optional_string_array(
    obj: dict[str, object], key: str, where: str, card_index: int
) -> list[str] | None:
    value = _get(obj, key)
    if value is _MISSING or value is None:
        return None
    if not isinstance(value, list):
        raise CaptureExtractionError(
            "invalid_card",
            f"{where}.{key} must be an array of strings when present, got "
            f"{_describe(value)}.",
            card_index,
        )
    for entry in value:
        if not isinstance(entry, str) or not entry.strip():
            raise CaptureExtractionError(
                "invalid_card",
                f"{where}.{key} must contain only non-empty strings.",
                card_index,
            )
    return [entry.strip() for entry in value]


def _one_of(
    obj: dict[str, object],
    key: str,
    allowed: tuple[str, ...],
    where: str,
    card_index: int,
) -> str:
    value = _optional_one_of(obj, key, allowed, where, card_index)
    if value is None:
        raise CaptureExtractionError(
            "invalid_card",
            f"{where}.{key} is required and must be one of: {', '.join(allowed)}.",
            card_index,
        )
    return value


def _optional_one_of(
    obj: dict[str, object],
    key: str,
    allowed: tuple[str, ...],
    where: str,
    card_index: int,
) -> str | None:
    value = _get(obj, key)
    if value is _MISSING or value is None:
        return None
    if not isinstance(value, str) or value not in allowed:
        raise CaptureExtractionError(
            "invalid_card",
            f"{where}.{key} must be one of {', '.join(allowed)}, got "
            f"{_describe(value)}.",
            card_index,
        )
    return value


def _optional_timestamp(
    obj: dict[str, object], card_index: int, where: str, now_ms: int
) -> int:
    value = _get(obj, "timestamp")
    if value is _MISSING or value is None:
        return now_ms
    # bool before int: in Python True is an int, and in the TypeScript original
    # `typeof true !== 'number'` rejects it.
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise CaptureExtractionError(
            "invalid_card",
            f"{where}.timestamp must be a finite number of epoch milliseconds "
            f"when present, got {_describe(value)}. Omit it and the service "
            f"will stamp the card.",
            card_index,
        )
    return int(value)


def _build(
    model: type[InsightCard] | type[InsightDetails],
    values: dict[str, object],
    where: str,
    card_index: int,
):
    """Construct the wire model from values this module has already validated.

    The try/except is defence in depth, not the primary validation: it exists
    so that nothing but CaptureExtractionError can escape the parser, even if a
    future field is added to schemas.py without a validator here.
    """
    try:
        return model(**values)
    except ValidationError as exc:
        # exc.errors() also carries `input` — the model's own value, which may
        # quote the transcript. Only the field locations are read, and the chain
        # is suppressed so the pydantic message cannot reach a log line.
        locations = [
            ".".join(str(part) for part in error.get("loc", ()))
            for error in exc.errors()
        ]
        raise CaptureExtractionError(
            "invalid_card",
            f"{where} could not be built: rejected field(s) "
            f"{_safe_key_names(locations)}.",
            card_index,
        ) from None


def _default_new_id(index: int) -> str:
    # Same shape the TypeScript parser mints: `insight-<uuid>`. `index` is
    # unused by the default mint but is part of the injectable signature so a
    # test (or a future caller wanting deterministic ids) can use it.
    del index
    return f"insight-{uuid.uuid4()}"


def _epoch_ms() -> int:
    return int(time.time() * 1000)


# ─── Message helpers ────────────────────────────────────────────────────────

_IDENTIFIER_KEY = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,63}$")


def _safe_key_names(keys: list[str]) -> str:
    """Key names fit for a log line.

    A model that invents a field almost always invents an identifier
    ("confidence", "risk_level"), and naming it is the whole diagnostic. A key
    that is not identifier-shaped is prose, and prose here came from the
    transcript — so it is counted, not printed.
    """
    printable = [key for key in keys if _IDENTIFIER_KEY.match(key)]
    hidden = len(keys) - len(printable)
    if not printable:
        return f"{len(keys)} unprintable key name(s)"
    if hidden:
        return ", ".join(printable) + f" (+{hidden} unprintable key name(s))"
    return ", ".join(printable)


def _describe(value: object) -> str:
    """Type-only description of a rejected value.

    The TypeScript parser quotes string values here. This one never does: the
    fields being described include `title` and `description`, whose values are
    transcript content, and this message goes to the service log.
    """
    if value is _MISSING:
        return "nothing (the key is missing)"
    if value is None:
        return "null"
    # bool before int: bool is a subclass of int in Python.
    if isinstance(value, bool):
        return f"boolean {str(value).lower()}"
    if isinstance(value, (int, float)):
        return f"number {value}"
    if isinstance(value, str):
        return "an empty string" if not value.strip() else "a string"
    if isinstance(value, list):
        return "an array"
    if isinstance(value, dict):
        return "an object"
    return type(value).__name__
