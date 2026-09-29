"""Parity with the TypeScript half of the capture contract.

The Python service and the TypeScript app must agree on the InsightCard shape,
the prompt, the parser's allowlists and the error codes — they are two
implementations of one contract, and nothing at runtime keeps them in step.
These tests read the TypeScript SOURCE and fail when it drifts.

They are the reason the duplication in capture_service/prompt.py and
capture_service/parse_cards.py is safe: a change to
lib/connectors/capture/extractionPrompt.ts, lib/ai/summaryPrompt.ts or
parseInsightCards.ts breaks this file until the Python copy is updated to match.

The tests read files two directories up, so they require a full checkout of the
repository (which is what CI checks out). They fail loudly rather than skipping
if a TypeScript file is missing — a silently skipped parity test is no test.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from capture_service import errors as errors_module
from capture_service.errors import PARSE_FAILURE_REASONS, CaptureServiceError
from capture_service.ollama import MAX_OUTPUT_TOKENS
from capture_service.parse_cards import (
    CARD_KEYS,
    DECISION_ROLES,
    DESIGN_STAGES,
    DETAILS_KEYS,
    ENVELOPE_KEYS,
    INSIGHT_TYPES,
    PRIORITIES,
    STATUSES,
)
from capture_service.prompt import (
    EXTRACTION_SYSTEM_PROMPT,
    SUMMARY_SYSTEM_PROMPT,
    build_summary_user_prompt,
    format_summary_card,
)
from capture_service.schemas import (
    InsightCard,
    InsightDetails,
    InsightType,
    Priority,
    SlideContext,
    Status,
    TranscriptChunk,
)
from capture_service.transcribe import MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_CHUNKS

REPO_ROOT = Path(__file__).resolve().parents[2]
CAPTURE_TS = REPO_ROOT / "lib" / "connectors" / "capture"
TYPES_TS = REPO_ROOT / "types.ts"
EXTRACT_ENDPOINT_TS = REPO_ROOT / "api" / "capture" / "extract.ts"
EXTRACT_CLIENT_TS = CAPTURE_TS / "extractClient.ts"
OLLAMA_DIRECT_TS = CAPTURE_TS / "ollamaDirect.ts"
SUMMARY_PROMPT_TS = REPO_ROOT / "lib" / "ai" / "summaryPrompt.ts"
# The server-side AI router (plan 14, batch BF). It owns the output-token ceiling
# for every cloud provider now; api/capture/extract.ts used to, and still owns the
# transcript budget the request-validation tests below pin.
ROUTER_TS = REPO_ROOT / "lib" / "ai" / "router.ts"


def read_typescript(path: Path) -> str:
    assert path.exists(), (
        f"{path.relative_to(REPO_ROOT)} is missing. These parity tests read the "
        f"TypeScript source directly, so they need a full repository checkout."
    )
    # Normalised, because a Windows checkout may have CRLF in the working tree
    # while the Python copy of the prompt has LF.
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def strip_ts_comments(source: str) -> str:
    """Remove // and /* */ comments before pulling declarations out.

    Necessary, not cosmetic: the doc comments in parseInsightCards.ts contain
    quoted words and brackets (`{ "cards": [...] }`), which a naive
    string-literal scan picks up as members of the declaration being read.
    """
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"//[^\n]*", "", source)


def ts_const_list(source: str, name: str) -> list[str]:
    """The string members of `const NAME = [...]` (with or without `as const`)."""
    match = re.search(
        rf"\b{name}\b[^=\n]*=\s*\[(.*?)\]", strip_ts_comments(source), re.S
    )
    assert match, f"could not find a `{name}` array literal"
    return re.findall(r"""['"]([^'"]+)['"]""", match.group(1))


def ts_set(source: str, name: str) -> set[str]:
    """The members of `const NAME = new Set([...])`."""
    match = re.search(
        rf"\b{name}\b\s*=\s*new Set\(\[(.*?)\]\)", strip_ts_comments(source), re.S
    )
    assert match, f"could not find a `{name}` Set literal"
    return set(re.findall(r"""['"]([^'"]+)['"]""", match.group(1)))


def ts_type_union(source: str, name: str) -> list[str]:
    """The members of `type NAME = 'A' | 'B';`."""
    match = re.search(
        rf"\btype\s+{name}\b[^=]*=(.*?);", strip_ts_comments(source), re.S
    )
    assert match, f"could not find a `{name}` type alias"
    return re.findall(r"""['"]([^'"]+)['"]""", match.group(1))


def ts_interface_fields(source: str, name: str) -> set[str]:
    """The field names of `interface NAME { ... }`, ignoring comments."""
    match = re.search(rf"interface\s+{name}\s*\{{(.*?)^\}}", source, re.S | re.M)
    assert match, f"could not find an interface named `{name}`"
    body = "\n".join(
        line
        for line in match.group(1).splitlines()
        if not line.strip().startswith(("//", "*", "/*"))
    )
    return set(re.findall(r"^\s*(\w+)\??:", body, re.M))


def wire_names(model: type[InsightCard]) -> set[str]:
    return {field.alias or name for name, field in model.model_fields.items()}


# ─── The prompt ─────────────────────────────────────────────────────────────


def test_the_extraction_prompt_is_byte_identical_to_the_typescript_one() -> None:
    source = read_typescript(CAPTURE_TS / "extractionPrompt.ts")
    match = re.search(
        r"EXTRACTION_SYSTEM_PROMPT\s*=\s*`(.*?)`;", source, re.S
    )
    assert match, "could not find EXTRACTION_SYSTEM_PROMPT in extractionPrompt.ts"
    assert EXTRACTION_SYSTEM_PROMPT == match.group(1), (
        "The Python copy of the extraction prompt has drifted from "
        "lib/connectors/capture/extractionPrompt.ts. The TypeScript file is the "
        "authority: change it there, then re-copy it verbatim into "
        "capture_service/prompt.py."
    )


def test_the_transcript_is_rendered_with_the_same_labels_the_prompt_promises() -> None:
    # formatTranscript in extractionPrompt.ts: `c{i} [{start}-{end}] {speaker}: {text}`
    source = read_typescript(CAPTURE_TS / "extractionPrompt.ts")
    assert "`c${i} [${start}-${end}] ${chunk.speakerId}: ${chunk.text}`" in source
    from capture_service.prompt import format_transcript

    rendered = format_transcript(
        [
            TranscriptChunk(
                speaker_id="speaker-1", text="Hello there.", start_ms=65_000, end_ms=70_000
            )
        ]
    )
    assert rendered == "c0 [01:05-01:10] speaker-1: Hello there."


def test_the_user_prompt_layout_matches_the_typescript_builder() -> None:
    source = read_typescript(CAPTURE_TS / "extractionPrompt.ts")
    for fragment in (
        "`Today's date: ${today} (${weekdayOf(today)})`",
        "`Next 14 days: ${upcomingDays(today, 14)}`",
        "days.push(`${weekdayOf(d)} ${d}`)",
        "new Date().toISOString().slice(0, 10)",
        "`Agenda item ${context.agendaIdx}: ${context.slideTitle}`",
        "`A speaker was hovering over: ${context.hoveredPartName}`",
        "`The laser pointer was on: ${context.laserTargetPartName}`",
        "'Components in this model:'",
        "'What people were pointing at:'",
        "'Speaker transcript (attribution hint",
        "'Transcript window:'",
    ):
        assert fragment in source, f"{fragment} is no longer how the TS builder renders"


# ─── The minutes prompt ─────────────────────────────────────────────────────
#
# lib/ai/summaryPrompt.ts is the authority for POST /summarize, in the same way
# extractionPrompt.ts is for /capture and /extract. The system prompt is a
# verbatim copy; the user prompt is a reimplementation, so its layout is pinned
# fragment by fragment and then by rendering one.


def test_the_summary_prompt_is_byte_identical_to_the_typescript_one() -> None:
    source = read_typescript(SUMMARY_PROMPT_TS)
    match = re.search(r"SUMMARY_SYSTEM_PROMPT\s*=\s*`(.*?)`;", source, re.S)
    assert match, "could not find SUMMARY_SYSTEM_PROMPT in summaryPrompt.ts"
    assert SUMMARY_SYSTEM_PROMPT == match.group(1), (
        "The Python copy of the summary prompt has drifted from "
        "lib/ai/summaryPrompt.ts. The TypeScript file is the authority: change "
        "it there, then re-copy it verbatim into capture_service/prompt.py."
    )


def test_the_summary_prompt_keeps_the_sections_and_the_action_format() -> None:
    # Asserted separately from the byte-for-byte copy above so that a rewrite of
    # the prompt still fails on the two things the minutes are judged by: the
    # section list the reader expects, and the checkbox format the Manager
    # workspace turns back into an action.
    source = read_typescript(SUMMARY_PROMPT_TS)
    for section in (
        "## What was reviewed",
        "## Decisions",
        "## Risks raised",
        "## Actions",
        "## Open questions",
    ):
        assert section in SUMMARY_SYSTEM_PROMPT, section
        assert section in source, section
    assert '"- [ ] task — owner (by date)"' in source


def test_the_summary_user_prompt_fragments_are_how_the_typescript_renders_them() -> None:
    source = read_typescript(SUMMARY_PROMPT_TS)
    for fragment in (
        "`Today's date: ${new Date().toISOString().slice(0, 10)}`",
        "`Meeting: ${title?.trim() || 'Design review'}`",
        "'Insight cards already extracted from this meeting: none.'",
        "'Insight cards already extracted from this meeting:'",
        "`k${index} [${card.type}] ${card.title}: ${card.description}${suffix}`",
        "` (${extras.join('; ')})`",
        "'Transcript: none — write the minutes from the cards alone.'",
        "'Transcript:'",
        # The same chunk labels the extraction prompt uses, so a card's
        # sourceMessageIds mean the same thing in both prompts.
        "`c${i} [${start}-${end}] ${chunk.speakerId}: ${chunk.text}`",
        "const SECTION_ORDER = ['RISK', 'RATIONALE', 'ACTION'] as const;",
    ):
        assert fragment in source, f"{fragment} is no longer how the TS builder renders"


def test_the_summary_card_extras_come_out_in_the_typescript_order() -> None:
    source = read_typescript(SUMMARY_PROMPT_TS)
    labels = re.findall(r"extras\.push\(`(\w+): \$\{details\.", source)
    assert labels == [
        "component",
        "assignee",
        "department",
        "due",
        "priority",
        "impact",
        "mitigation",
        "driver",
    ], "formatCard in summaryPrompt.ts renders its extras in a new order"

    rendered = format_summary_card(
        InsightCard(
            id="insight-1",
            type=InsightType.RISK,
            agent_id="speaker-1",
            title="Weld cracks",
            description="It will crack before the yield target.",
            timestamp=0,
            details=InsightDetails(
                priority=Priority.HIGH,
                status=Status.OPEN,
                assignee="Alice",
                due_date="2026-09-30",
                component_reference="left_cup",
                impact="Warranty returns",
                mitigation_strategy="Add a gusset",
                design_driver="Stiffness target",
                department="Frame",
            ),
        ),
        0,
    )
    # Values here contain no colon, so the label is everything before the first
    # one. `status` is deliberately absent from `labels`: the TS does not
    # render it, and neither may this.
    suffix = rendered.split(" (", 1)[1].rstrip(")")
    assert [part.split(":")[0].strip() for part in suffix.split("; ")] == labels
    assert rendered.startswith("k0 [RISK] Weld cracks: ")


def _fixture_card(card_type: InsightType, title: str) -> InsightCard:
    return InsightCard(
        id=f"insight-{title}",
        type=card_type,
        agent_id="speaker-1",
        title=title,
        description="Because the weld will crack.",
        timestamp=0,
        details=InsightDetails(priority=Priority.HIGH),
    )


def test_the_summary_user_prompt_layout_matches_the_typescript_builder() -> None:
    prompt = build_summary_user_prompt(
        [
            TranscriptChunk(
                speaker_id="speaker-1",
                text="The weld will crack.",
                start_ms=0,
                end_ms=4200,
            )
        ],
        # Sent action-first on purpose: SECTION_ORDER re-sorts them, and the
        # k-labels are positional over the sorted list.
        [
            _fixture_card(InsightType.ACTION, "Re-run the FEA"),
            _fixture_card(InsightType.RISK, "Weld cracks"),
        ],
        "Rear triangle weld",
    )
    lines = prompt.split("\n")
    assert lines[0].startswith("Today's date: ")
    assert lines[1] == ""
    assert lines[2] == "Meeting: Rear triangle weld"
    assert lines[3] == ""
    assert lines[4] == "Insight cards already extracted from this meeting:"
    assert lines[5].startswith("k0 [RISK] Weld cracks: ")
    assert lines[6].startswith("k1 [ACTION] Re-run the FEA: ")
    assert lines[7] == ""
    assert lines[8] == "Transcript:"
    assert lines[9] == "c0 [00:00-00:04] speaker-1: The weld will crack."
    assert len(lines) == 10, "the transcript is the last section"


def test_absent_summary_inputs_are_named_the_way_the_builder_names_them() -> None:
    prompt = build_summary_user_prompt([], [])
    assert "Insight cards already extracted from this meeting: none." in prompt
    # The trailing newline is what the TypeScript `lines.join('\n')` produces
    # when formatTranscript returns "" — not padding invented here.
    assert prompt.endswith(
        "Transcript: none — write the minutes from the cards alone.\n"
    )


def test_a_blank_summary_title_falls_back_to_the_typescript_default() -> None:
    for title in (None, "", "   "):
        assert "Meeting: Design review" in build_summary_user_prompt([], [], title)


# ─── The card shape ─────────────────────────────────────────────────────────


def test_the_card_key_allowlist_matches_the_typescript_parser() -> None:
    source = read_typescript(CAPTURE_TS / "parseInsightCards.ts")
    assert CARD_KEYS == ts_set(source, "CARD_KEYS")
    assert DETAILS_KEYS == ts_set(source, "DETAILS_KEYS")
    assert ENVELOPE_KEYS == ts_set(source, "ENVELOPE_KEYS")


def test_the_card_key_allowlist_matches_types_ts() -> None:
    source = read_typescript(TYPES_TS)
    assert CARD_KEYS == ts_interface_fields(source, "InsightCard")
    assert DETAILS_KEYS == ts_interface_fields(source, "InsightDetails")


def test_the_wire_models_serialise_to_the_typescript_field_names() -> None:
    assert wire_names(InsightCard) == CARD_KEYS
    assert wire_names(InsightDetails) == DETAILS_KEYS


def test_the_transcript_chunk_shape_matches_the_typescript_interface() -> None:
    source = read_typescript(CAPTURE_TS / "types.ts")
    assert wire_names(TranscriptChunk) == ts_interface_fields(source, "TranscriptChunk")
    assert wire_names(TranscriptChunk) == {"speakerId", "text", "startMs", "endMs"}


def test_the_slide_context_shape_matches_the_typescript_interface() -> None:
    source = read_typescript(CAPTURE_TS / "types.ts")
    assert wire_names(SlideContext) == ts_interface_fields(source, "SlideContext")


# ─── The enums ──────────────────────────────────────────────────────────────


def test_the_insight_types_match_both_typescript_declarations() -> None:
    parser_source = read_typescript(CAPTURE_TS / "parseInsightCards.ts")
    types_source = read_typescript(TYPES_TS)
    assert set(INSIGHT_TYPES) == set(ts_const_list(parser_source, "INSIGHT_TYPES"))
    assert set(INSIGHT_TYPES) == set(ts_type_union(types_source, "InsightType"))


def test_the_parser_allowlists_match_the_typescript_parser() -> None:
    source = read_typescript(CAPTURE_TS / "parseInsightCards.ts")
    assert list(PRIORITIES) == ts_const_list(source, "PRIORITIES")
    assert list(STATUSES) == ts_const_list(source, "STATUSES")
    assert list(DECISION_ROLES) == ts_const_list(source, "DECISION_ROLES")
    assert list(DESIGN_STAGES) == ts_const_list(source, "DESIGN_STAGES")


def test_the_enums_match_the_unions_declared_in_types_ts() -> None:
    source = read_typescript(TYPES_TS)
    details = re.search(r"interface\s+InsightDetails\s*\{(.*?)^\}", source, re.S | re.M)
    assert details, "could not find InsightDetails in types.ts"
    body = details.group(1)

    def field_union(field: str) -> set[str]:
        match = re.search(rf"{field}\??:\s*([^;]+);", body)
        assert match, f"could not find `{field}` in InsightDetails"
        return set(re.findall(r"""['"]([^'"]+)['"]""", match.group(1)))

    assert set(PRIORITIES) == field_union("priority")
    assert set(STATUSES) == field_union("status")
    assert set(DESIGN_STAGES) == field_union("designStage")
    assert set(DECISION_ROLES) == set(ts_type_union(source, "DecisionRole"))


# ─── The parse-failure vocabulary ───────────────────────────────────────────


def test_the_parse_failure_reasons_match_the_typescript_union() -> None:
    source = read_typescript(CAPTURE_TS / "parseInsightCards.ts")
    assert PARSE_FAILURE_REASONS == frozenset(
        ts_type_union(source, "CaptureParseFailureReason")
    )


def test_the_parse_failure_reason_literal_covers_the_same_vocabulary() -> None:
    # The Literal in errors.py is what the type checker sees; the frozenset is
    # what the tests assert against. They must not disagree.
    source = Path(errors_module.__file__).read_text(encoding="utf-8")
    match = re.search(r"ParseFailureReason = Literal\[(.*?)\n\]", source, re.S)
    assert match, "could not find the ParseFailureReason Literal in errors.py"
    without_comments = re.sub(r"#[^\n]*", "", match.group(1))
    assert set(re.findall(r'"([a-z_]+)"', without_comments)) == PARSE_FAILURE_REASONS


# ─── Limits and knobs shared with the TypeScript capture path ───────────────


def test_the_output_token_limit_matches_the_typescript_providers() -> None:
    # Two TypeScript copies of the ceiling, and this test is why there are only
    # two: the browser-side Ollama provider (which talks to Ollama directly, with
    # no server in between) and the server-side router (which calls every other
    # provider). api/capture/extract.ts no longer appears here because batch BF
    # moved the upstream calls out of the endpoint and into lib/ai/router.ts —
    # the endpoint validates a request, it does not talk to a model.
    for path in (OLLAMA_DIRECT_TS, ROUTER_TS):
        source = read_typescript(path)
        match = re.search(r"MAX_OUTPUT_TOKENS\s*=\s*(\d+)", source)
        assert match, f"could not find MAX_OUTPUT_TOKENS in {path.name}"
        assert MAX_OUTPUT_TOKENS == int(match.group(1)), path.name


def test_the_default_timeout_matches_the_typescript_ollama_provider() -> None:
    from capture_service.config import DEFAULT_TIMEOUT_SECONDS

    source = read_typescript(OLLAMA_DIRECT_TS)
    match = re.search(r"DEFAULT_TIMEOUT_MS\s*=\s*([\d_]+)", source)
    assert match, "could not find DEFAULT_TIMEOUT_MS in ollamaDirect.ts"
    assert DEFAULT_TIMEOUT_SECONDS * 1000 == int(match.group(1).replace("_", ""))


def test_the_transcript_budget_matches_the_cloud_extraction_endpoint() -> None:
    source = read_typescript(EXTRACT_ENDPOINT_TS)
    chunks = re.search(r"MAX_CHUNKS\s*=\s*([\d_]+)", source)
    chars = re.search(r"MAX_TRANSCRIPT_CHARS\s*=\s*([\d_]+)", source)
    assert chunks and chars, "could not find the transcript limits in extract.ts"
    assert MAX_TRANSCRIPT_CHUNKS == int(chunks.group(1).replace("_", ""))
    assert MAX_TRANSCRIPT_CHARS == int(chars.group(1).replace("_", ""))


def test_the_ollama_request_payload_matches_the_browser_provider() -> None:
    source = read_typescript(OLLAMA_DIRECT_TS)
    # The knobs that must be identical for two front ends to get the same
    # behaviour out of the same model.
    for fragment in ("stream: false", "format: EXTRACTION_JSON_SCHEMA", "temperature: 0"):
        assert fragment in source, f"{fragment} is no longer what ollamaDirect.ts sends"


# ─── The error vocabulary the browser client switches on ────────────────────


def service_error_codes() -> set[str]:
    """Every `code` a CaptureServiceError subclass can produce."""
    codes: set[str] = set()

    def walk(cls: type[CaptureServiceError]) -> None:
        for subclass in cls.__subclasses__():
            codes.add(subclass.code)
            walk(subclass)

    walk(CaptureServiceError)
    return codes


def client_known_codes() -> set[str]:
    source = read_typescript(EXTRACT_CLIENT_TS)
    return set(re.findall(r"case '([a-z_]+)':", source))


# The codes this service shares with api/capture/extract.ts. The browser client
# has an explicit `case` for each, so it renders a specific message instead of
# falling through to the generic default branch.
SHARED_WITH_THE_CLOUD_ENDPOINT = {
    "capture_parse_error",
    "capture_output_truncated",
    "capture_upstream_error",
    "capture_upstream_unreachable",
    "empty_transcript",
    "transcript_too_large",
}


def test_the_shared_error_codes_are_ones_the_browser_client_understands() -> None:
    codes = service_error_codes()
    known = client_known_codes()
    assert SHARED_WITH_THE_CLOUD_ENDPOINT <= codes, "a shared code is not emitted here"
    assert SHARED_WITH_THE_CLOUD_ENDPOINT <= known, "the browser client has no case for it"


def test_every_error_code_is_a_stable_snake_case_identifier() -> None:
    # The codes are a wire contract: no spaces, no punctuation, no version
    # suffixes that would make a client's switch statement brittle.
    for code in service_error_codes():
        assert re.fullmatch(r"[a-z][a-z0-9_]*", code), code


def test_service_only_codes_do_not_collide_with_the_cloud_endpoint() -> None:
    # Codes unique to this service fall through to the client's default branch,
    # which prints the code. They must therefore be self-explanatory and must
    # not reuse a cloud-endpoint code with a different meaning.
    ours = service_error_codes() - SHARED_WITH_THE_CLOUD_ENDPOINT
    cloud_only = {"capture_not_configured", "invalid_body", "invalid_provider"}
    assert not (ours & cloud_only)


@pytest.mark.parametrize("code", sorted(service_error_codes()))
def test_every_error_code_has_a_documented_status(code: str) -> None:
    statuses = {
        subclass.code: subclass.status
        for subclass in _all_error_subclasses()
    }
    assert 400 <= statuses[code] <= 599, code


def _all_error_subclasses() -> list[type[CaptureServiceError]]:
    found: list[type[CaptureServiceError]] = []

    def walk(cls: type[CaptureServiceError]) -> None:
        for subclass in cls.__subclasses__():
            found.append(subclass)
            walk(subclass)

    walk(CaptureServiceError)
    return found


def test_the_ollama_json_schema_is_identical_to_the_typescript_one() -> None:
    import json

    from capture_service.prompt import EXTRACTION_JSON_SCHEMA

    ts_copy = json.loads((CAPTURE_TS / "extractionSchema.json").read_text(encoding="utf-8"))
    assert EXTRACTION_JSON_SCHEMA == ts_copy, (
        "capture_service/extraction_schema.json has drifted from "
        "lib/connectors/capture/extractionSchema.json; copy the TS one over"
    )


def test_the_json_schema_only_allows_keys_the_parser_accepts() -> None:
    from capture_service.parse_cards import CARD_KEYS, DETAILS_KEYS
    from capture_service.prompt import EXTRACTION_JSON_SCHEMA

    card = EXTRACTION_JSON_SCHEMA["properties"]["cards"]["items"]
    assert set(card["properties"]) <= set(CARD_KEYS)
    assert set(card["properties"]["details"]["properties"]) <= set(DETAILS_KEYS)
    assert card["additionalProperties"] is False
    assert card["properties"]["details"]["additionalProperties"] is False
