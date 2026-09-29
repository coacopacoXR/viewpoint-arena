"""Wire shapes shared with the TypeScript app.

These models are the Python half of a contract that already exists in
TypeScript, and they are deliberately not free to drift:

  * `TranscriptChunk`  ↔ lib/connectors/capture/types.ts `TranscriptChunk`
  * `SlideContext`     ↔ lib/connectors/capture/types.ts `SlideContext`
  * `InsightCard`      ↔ types.ts `InsightCard`
  * `InsightDetails`   ↔ types.ts `InsightDetails`

Field names go over the wire in camelCase, exactly as the TypeScript types
spell them, because the browser client re-validates this service's responses
with the same strict parser it uses for the cloud path
(`validateExtractionPayload` in lib/connectors/capture/parseInsightCards.ts).
That parser rejects UNKNOWN KEYS, so a snake_case field or an extra
transport-metadata key on the response envelope is not a cosmetic difference —
it is a rejected response. tests/test_typescript_parity.py pins the key sets
against the TypeScript source.

Enums mirror the TypeScript string-literal unions value-for-value; parse_cards
derives its allowlists from them so a value cannot be legal in one place and
illegal in another.

The two JSON request bodies (`ExtractRequest`, `SummaryRequest`) are the
text-only half of the same contract: the server-side AI router
(docs/plan/14-rooms-models-admin-ai.md) picks a provider per job, so the
transcription and the extraction may come from different places and the
service needs routes that take a transcript instead of a recording. They are
the only request MODELS here — /capture and /transcribe are multipart forms,
whose fields FastAPI validates individually.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


def _to_camel(snake: str) -> str:
    head, *rest = snake.split("_")
    return head + "".join(word[:1].upper() + word[1:] for word in rest)


class WireModel(BaseModel):
    """Base for everything that crosses the HTTP boundary.

    `extra="forbid"` is a guard against this service silently growing a field
    the TypeScript parser would then reject on the client.
    """

    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
    )


class InsightType(StrEnum):
    RISK = "RISK"
    RATIONALE = "RATIONALE"
    ACTION = "ACTION"


class Priority(StrEnum):
    CRITICAL = "Critical"
    HIGH = "High"
    MEDIUM = "Medium"
    LOW = "Low"


class Status(StrEnum):
    OPEN = "Open"
    IN_REVIEW = "In Review"
    APPROVED = "Approved"
    REJECTED = "Rejected"


class DecisionRole(StrEnum):
    TRIGGER = "TRIGGER"
    RATIONALE = "RATIONALE"
    INTERMEDIATE_DECISION = "INTERMEDIATE_DECISION"
    FINAL_DECISION = "FINAL_DECISION"


class DesignStage(StrEnum):
    DETAILED_DESIGN = "DETAILED_DESIGN"


class TranscriptChunk(WireModel):
    """One speaker-labelled slice of a real transcript."""

    speaker_id: str
    text: str
    start_ms: int
    end_ms: int


# Batch mode has one SlideContext for the whole recording — the agenda item the
# host was presenting, or the meeting title. A blank value from the client is
# replaced with this rather than being passed to the model as an empty label.
DEFAULT_SLIDE_TITLE = "Full meeting recording"


class SlideContext(WireModel):
    """Where the review was, spatially, when the transcript was captured."""

    agenda_idx: int = 0
    slide_title: str = DEFAULT_SLIDE_TITLE
    hovered_part_name: str | None = None
    laser_target_part_name: str | None = None


class InsightDetails(WireModel):
    """Per-type detail fields of an InsightCard.

    `priority` is required and `status` defaults to Open, exactly as the
    TypeScript parser does: the Manager workspace triages on priority, and
    guessing one would invent an engineering judgement the model never made.
    """

    priority: Priority
    status: Status = Status.OPEN
    assignee: str | None = None
    due_date: str | None = None
    #: The deadline as it was spoken — "by Friday" — copied verbatim by the
    #: model. lib/capture/resolveDeadline.ts resolves it in code and prefers its
    #: answer over `due_date`, because a small model gets the arithmetic wrong.
    due_date_text: str | None = None
    component_reference: str | None = None
    design_stage: DesignStage | None = None
    decision_role: DecisionRole | None = None
    impact: str | None = None
    mitigation_strategy: str | None = None
    design_driver: str | None = None
    alternatives_considered: str | None = None
    tradeoff_analysis: str | None = None
    department: str | None = None


class InsightCard(WireModel):
    """The unit the whole capture pipeline exists to produce.

    `source` and `created_by_name` exist on the TypeScript InsightCard for the
    cards a person typed in the room (docs/plan/14 batch BG), and
    tests/test_typescript_parity.py holds this model to the same key set — but
    parse_cards never sets them, and must not: every card this service returns
    was written by a model, so it is an AI card whatever the model claimed.
    """

    id: str
    type: InsightType
    agent_id: str
    title: str
    description: str
    timestamp: int
    details: InsightDetails
    related_poi_id: str | None = None
    source_message_ids: list[str] | None = None
    source: Literal["ai", "manual"] | None = None
    created_by_name: str | None = None
    affected_requirement_ids: list[str] | None = None
    kb_recommendations: list[str] | None = None


# ─── Request bodies ─────────────────────────────────────────────────────────


class ExtractRequest(WireModel):
    """POST /extract: a transcript in, InsightCards out. No audio anywhere.

    The three grounded fields are typed `object` on purpose. Everywhere else
    in this file a strict type is the point, but these three are advisory
    context, and /capture's rule for them is that a malformed value degrades
    to "not sent" instead of failing a request that would otherwise have
    worked — a client that JSON-stringified one by mistake must not lose the
    whole extraction over it. main._filter_* is therefore the single authority
    on their shape and their caps, and it is applied to whatever arrives here.
    """

    transcript: list[TranscriptChunk]
    context: SlideContext | None = None
    component_tree: object | None = Field(
        default=None,
        description='[{ "id", "name", "path" }] from the loaded model tree. Advisory: a malformed value is ignored.',
    )
    pointing_segments: object | None = Field(
        default=None,
        description='[{ "userId", "userName", "partId", "partName", "fromMs", "toMs" }]. Advisory.',
    )
    transcript_hint: object | None = Field(
        default=None,
        description='[{ "speaker", "text", "offsetMs" }] attribution hint. Advisory; never a source of truth.',
    )


class SummaryRequest(WireModel):
    """POST /summarize: a transcript and/or cards in, markdown minutes out.

    Both lists default to empty because either alone is enough to write from:
    cards-only is what a caller has when the transcript was not kept, and
    transcript-only is what a caller has when extraction was routed to a
    different provider. Only both-empty is refused (EmptySummaryInput).

    `cards` is the full InsightCard wire shape, `extra="forbid"` included, so
    a malformed card is a 400 invalid_request naming the field rather than a
    500 or a silently dropped insight.
    """

    transcript: list[TranscriptChunk] = Field(default_factory=list)
    cards: list[InsightCard] = Field(default_factory=list)
    title: str | None = None


# ─── Response envelopes ─────────────────────────────────────────────────────
#
# Each response is EXACTLY its envelope and nothing else. api/capture/extract.ts
# returns bare `{ cards }` for the same reason: the browser re-validates the
# body verbatim with the strict parser, which rejects unknown keys, so adding
# transport metadata ("took 4.2s", "model": …) would break the client.


class CaptureResponse(WireModel):
    cards: list[InsightCard]


class SummaryResponse(WireModel):
    """Markdown minutes, and nothing else.

    A single string field with no structure to validate is the point: the
    answer is prose a person reads, so there is no envelope for a parser to
    reject and no reason to put a JSON round trip between the model and the
    reader (lib/ai/summaryPrompt.ts makes the same call).
    """

    summary: str


class TranscribeResponse(WireModel):
    transcript: list[TranscriptChunk]


class WhisperHealth(WireModel):
    model: str
    device: str
    compute_type: str
    loaded: bool


class LlmHealth(WireModel):
    base_url: str
    model: str


class LimitsHealth(WireModel):
    max_upload_bytes: int
    max_transcript_chars: int
    max_transcript_chunks: int


class ErrorBody(WireModel):
    """Every non-2xx body this service returns.

    Documentation of what the exception handlers in main.py emit — the handlers
    build these dicts directly, so a field added here must be added there too.
    The contract with the browser (lib/connectors/capture/extractClient.ts) is
    that `error` is a stable machine-readable code and everything else is
    optional metadata: never a transcript, never model output, never a
    credential, never a filesystem path.
    """

    error: str
    # Present on capture_parse_error: the parser's failure classification.
    reason: str | None = None
    # Present on capture_parse_error when one card caused it.
    card_index: int | None = None
    # Present on upload_too_large.
    max_upload_bytes: int | None = None
    # Present on invalid_request: the FIELD NAMES that failed, never values.
    fields: list[str] | None = None


class HealthResponse(WireModel):
    """Configuration summary for an install probe.

    Everything here is safe to expose unauthenticated: a LAN address, model
    names and numeric limits. No credential, no transcript, no filesystem path.
    The install script in docs/local-capture-plan.md §"Installation" is
    expected to GET this and print the result next to the other service URLs.
    """

    status: str
    service: str
    version: str
    whisper: WhisperHealth
    llm: LlmHealth
    limits: LimitsHealth
