"""The transcript → InsightCard extraction prompt, and the minutes prompt.

Ports of lib/connectors/capture/extractionPrompt.ts and lib/ai/summaryPrompt.ts.
The TypeScript originals are the authority and these copies must stay
byte-identical: OpenAI, Anthropic, browser-side Ollama and this service all ask
for the same payload precisely so that one parser can validate all of them, and
a summary that is phrased differently here than in the cloud is a summary that
reads differently depending on which provider an operator configured.
tests/test_typescript_parity.py fails the build if either drifts — if you change
a prompt, change it in the TypeScript first and re-copy it here.

Kept as literal strings rather than shared from a single source because the two
runtimes have no common module format; a parity test is the honest way to keep a
contract that crosses a language boundary.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

from .schemas import InsightCard, InsightType, SlideContext, TranscriptChunk

# The JSON Schema Ollama constrains its reply to. A copy of
# lib/connectors/capture/extractionSchema.json (the Docker build context is
# capture-service/ alone); tests/test_typescript_parity.py fails if they drift.
EXTRACTION_JSON_SCHEMA = json.loads(
    (Path(__file__).parent / "extraction_schema.json").read_text(encoding="utf-8")
)

# Copied verbatim from EXTRACTION_SYSTEM_PROMPT in
# lib/connectors/capture/extractionPrompt.ts. Do not edit locally.
EXTRACTION_SYSTEM_PROMPT = """You are the insight-capture layer of a CAD design-review tool.

You are given a window of a real review meeting's transcript and the 3D context the speakers were looking at. Extract the durable engineering insights from it as structured data.

Capture exactly three kinds of insight:
- RISK: a concern about the design, with its consequence. Something that could go wrong.
- RATIONALE: why a design decision was made, what drove it, what was traded off.
- ACTION: a task someone committed to or asked for, with an owner or department when one was named.

Do NOT capture small talk, agenda logistics, or restatements of what a slide already says. If the window contains nothing worth capturing, return zero cards.

Never invent a fact that is not in the transcript. Quote the speaker's own reasoning in the description. Use the component names the speakers actually used.

OUTPUT FORMAT — this is a hard requirement:
Reply with a single raw JSON object and nothing else. No markdown, no code fences, no leading or trailing prose, no commentary. The JSON must parse with JSON.parse as-is.

{
  "cards": [
    {
      "type": "RISK" | "RATIONALE" | "ACTION",
      "title": "<= 8 words, a noun phrase naming the insight",
      "description": "1-3 sentences carrying the speaker's actual reasoning",
      "agentId": "the speakerId this insight came from",
      "relatedPoiId": "optional: the component name discussed",
      "sourceMessageIds": ["optional: the chunk labels, e.g. c3, c4"],
      "details": {
        "priority": "Critical" | "High" | "Medium" | "Low",
        "status": "Open",
        "componentReference": "optional: component name from the model tree",
        "impact": "RISK only: what breaks if this is not addressed",
        "mitigationStrategy": "RISK only: what was proposed to reduce it",
        "designDriver": "RATIONALE only: the requirement or goal behind the decision",
        "alternativesConsidered": "RATIONALE only: what else was on the table",
        "tradeoffAnalysis": "RATIONALE only: what was given up",
        "department": "ACTION only: owning department",
        "assignee": "ACTION only: owning person",
        "dueDate": "ACTION only: YYYY-MM-DD. Resolve a relative deadline ("by Friday") against today's date given above the transcript; omit if no deadline was stated",
        "dueDateText": "ACTION only: the deadline exactly as it was spoken ("by Friday", "next week", "end of the month"). Copy the speaker's words verbatim and never convert them into a date; omit if no deadline was stated"
      }
    }
  ]
}

Rules:
- Omit optional fields you have no evidence for. Do not fill them with guesses or empty strings.
- Do not emit "id" or "timestamp"; the application assigns those.
- Do not add any field that is not listed above.
- "priority" is required on every card. Judge it from the speaker's own emphasis: Critical only for safety, yield-blocking or schedule-blocking concerns.
- Whenever a deadline was spoken, fill BOTH date fields: "dueDateText" with the speaker's own words, verbatim, and "dueDate" with your best reading of them. The application resolves "dueDateText" against the calendar it sends with the transcript and prefers that answer, because a copied phrase can be resolved exactly and a date you computed often cannot be.
- When a "Components in this model" list is provided, \\`componentReference\\` MUST be an id from that list, or omitted entirely. Never invent a component id. Never use a part name that is not in the list.
- When an utterance is deictic ("this", "that", "here") and a pointing segment from the same speaker overlaps its time window, prefer that part as the componentReference.
- Otherwise resolve a spoken component name against the list; if you are unsure which id matches, omit componentReference rather than guess."""


def format_ms(ms: float) -> str:
    """mm:ss, or '?' for a value that cannot be a timestamp.

    Same rendering as formatMs in extractionPrompt.ts, so the two services
    label the same chunk identically.
    """
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        return "?"
    if not math.isfinite(ms) or ms < 0:
        return "?"
    total_seconds = int(ms // 1000)
    minutes = total_seconds // 60
    seconds = total_seconds % 60
    return f"{minutes:02d}:{seconds:02d}"


def format_transcript(transcript: list[TranscriptChunk]) -> str:
    """Render the transcript with stable per-chunk labels (c0, c1, …).

    The labels are what the model is asked to put in `sourceMessageIds`, so
    they are positional and must not change between the prompt and the parse.
    """
    return "\n".join(
        f"c{index} [{format_ms(chunk.start_ms)}-{format_ms(chunk.end_ms)}] "
        f"{chunk.speaker_id}: {chunk.text}"
        for index, chunk in enumerate(transcript)
    )


WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def weekday_of(iso_date: str) -> str:
    """English weekday of a YYYY-MM-DD date, independent of locale (as weekdayOf in TS)."""
    try:
        return WEEKDAYS[date.fromisoformat(iso_date).weekday()]
    except ValueError:
        return "unknown"


def upcoming_days(iso_date: str, count: int) -> str:
    """"Tuesday 2026-09-22, Wednesday 2026-09-23, …" (as upcomingDays in TS).

    A calendar to look up, because small models get "by Friday" wrong when
    asked to compute it from today's date alone.
    """
    try:
        start = date.fromisoformat(iso_date)
    except ValueError:
        return "unknown"
    days = []
    for i in range(1, count + 1):
        d = (start + timedelta(days=i)).isoformat()
        days.append(f"{weekday_of(d)} {d}")
    return ", ".join(days)


def build_extraction_user_prompt(
    transcript: list[TranscriptChunk],
    context: SlideContext,
    today: str | None = None,
    *,
    components: list[dict[str, str]] | None = None,
    pointing_segments: list[dict[str, object]] | None = None,
    transcript_hint: list[dict[str, object]] | None = None,
) -> str:
    """Build the user turn: today's date and spatial context, then the transcript.

    Context comes first so the model can attribute a comment to the part that
    was on screen, exactly as the TypeScript builder does. Today's date (UTC,
    same as the TS default) lets it resolve "by Friday" to a real date.

    The three optional grounded sections (components, pointing segments,
    transcript hint) are rendered between the spatial context and the
    transcript window, matching the TypeScript builder order. The transcript
    hint is extra context for attribution — Whisper's transcript is still the
    source for extraction. A client could lie about the hint, so nothing
    security-relevant may depend on it.
    """
    if today is None:
        today = datetime.now(timezone.utc).date().isoformat()
    lines = [
        f"Today's date: {today} ({weekday_of(today)})",
        f"Next 14 days: {upcoming_days(today, 14)}",
        f"Agenda item {context.agenda_idx}: {context.slide_title}",
    ]
    if context.hovered_part_name:
        lines.append(f"A speaker was hovering over: {context.hovered_part_name}")
    if context.laser_target_part_name:
        lines.append(f"The laser pointer was on: {context.laser_target_part_name}")

    if components:
        lines.append("")
        lines.append("Components in this model:")
        for c in components:
            lines.append(f"{c['id']} · {c['path']}")

    if pointing_segments:
        lines.append("")
        lines.append("What people were pointing at:")
        for seg in pointing_segments:
            from_sec = round(int(seg["fromMs"]) / 1000)
            to_sec = round(int(seg["toMs"]) / 1000)
            lines.append(f"{seg['userName']} → {seg['partName']} ({from_sec}s–{to_sec}s)")

    if transcript_hint:
        lines.append("")
        lines.append(
            "Speaker transcript (attribution hint — Whisper transcript is the source for extraction):"
        )
        for line in transcript_hint:
            sec = round(int(line["offsetMs"]) / 1000)
            lines.append(f"[{line['speaker']}, t={sec}s] {line['text']}")

    lines.extend(["", "Transcript window:", format_transcript(transcript)])
    return "\n".join(lines)


# ─── The minutes prompt ─────────────────────────────────────────────────────
#
# Copied verbatim from SUMMARY_SYSTEM_PROMPT in lib/ai/summaryPrompt.ts. Do not
# edit locally: tests/test_typescript_parity.py compares this string to the
# TypeScript template literal byte for byte.
SUMMARY_SYSTEM_PROMPT = """You are the minute-taker of a CAD design-review tool.

You are given a real review meeting's transcript and the insight cards the app already extracted from it. Write the meeting's minutes.

OUTPUT FORMAT — this is a hard requirement:
Reply with Markdown and nothing else. No preamble, no closing remark, no code fence around the whole document. Start with a level-2 heading.

Use exactly these sections, in this order, and omit a section only when there is genuinely nothing to put in it:

## What was reviewed
One or two sentences: the product or assembly, and what the meeting was for.

## Decisions
A bullet per decision that was actually taken, with the reasoning the speaker gave. Attribute each one to the person who made it.

## Risks raised
A bullet per risk, with its consequence and any mitigation that was proposed.

## Actions
A bullet per action as "- [ ] task — owner (by date)". Use the owner and date the speakers named; write "unassigned" when nobody was named, and omit the date when none was given.

## Open questions
A bullet per question that was asked and not settled.

Rules:
- Never invent a fact that is not in the transcript or the cards. If nobody said who owns an action, do not guess an owner.
- Never write a person's name, a date or a decision that does not appear in the transcript or the cards. A short input gets short minutes.
- Quote a speaker's own words only when the wording itself matters.
- Use the component names the speakers actually used.
- Write in the past tense and in plain sentences. No marketing language, no "the team collaboratively leveraged".
- Keep it under 600 words. A minute nobody reads is not a minute."""

#: `title`'s fallback in buildSummaryUserPrompt. A blank title becomes this
#: rather than labelling the minutes "Meeting: " — the same reasoning as
#: DEFAULT_SLIDE_TITLE on the extraction side.
DEFAULT_SUMMARY_TITLE = "Design review"

#: Cards are grouped the way the minutes' own sections are ordered, so the
#: model reads risks before rationales before actions (SECTION_ORDER in the TS).
SUMMARY_SECTION_ORDER = (InsightType.RISK, InsightType.RATIONALE, InsightType.ACTION)


def format_summary_card(card: InsightCard, index: int) -> str:
    """One card as `k0 [RISK] title: description (component: …; assignee: …)`.

    A port of formatCard in lib/ai/summaryPrompt.ts: the same extras, in the
    same order, joined the same way, so a model gets identical text from either
    runtime. The `k` index is positional over the SECTION_ORDER-sorted list —
    NOT over the order the cards arrived in — which matters because the minutes
    are read next to the cards in the UI and a label that moved between the two
    would be worse than none.
    """
    details = card.details
    extras: list[str] = []
    # Truthiness, not `is not None`: an empty string is as absent as a missing
    # key here, exactly as the TypeScript `if (details.assignee)` treats it.
    for label, value in (
        ("component", details.component_reference),
        ("assignee", details.assignee),
        ("department", details.department),
        ("due", details.due_date),
        ("priority", details.priority),
        ("impact", details.impact),
        ("mitigation", details.mitigation_strategy),
        ("driver", details.design_driver),
    ):
        if value:
            extras.append(f"{label}: {value}")
    suffix = f" ({'; '.join(extras)})" if extras else ""
    return f"k{index} [{card.type}] {card.title}: {card.description}{suffix}"


def build_summary_user_prompt(
    transcript: list[TranscriptChunk],
    cards: list[InsightCard],
    title: str | None = None,
) -> str:
    """Build the user turn for a summary: date, meeting, cards, transcript.

    A port of buildSummaryUserPrompt in lib/ai/summaryPrompt.ts, line for line.
    Cards come BEFORE the transcript on purpose, as the TypeScript comment
    explains: they are the app's own already-validated reading of the meeting,
    and a model that has them in front of it while reading the raw transcript
    attributes actions to the right people far more often than one asked to
    rediscover them.

    The transcript is rendered by the same format_transcript the extraction
    prompt uses, so the c0…cN labels a card's `sourceMessageIds` refer to mean
    the same thing in both prompts.
    """
    today = datetime.now(timezone.utc).date().isoformat()
    lines = [
        f"Today's date: {today}",
        "",
        f"Meeting: {(title or '').strip() or DEFAULT_SUMMARY_TITLE}",
        "",
    ]

    ordered = [
        card
        for kind in SUMMARY_SECTION_ORDER
        for card in cards
        if card.type == kind
    ]
    lines.append(
        "Insight cards already extracted from this meeting: none."
        if not ordered
        else "Insight cards already extracted from this meeting:"
    )
    lines.extend(
        format_summary_card(card, index) for index, card in enumerate(ordered)
    )
    lines.append("")

    lines.append(
        "Transcript: none — write the minutes from the cards alone."
        if not transcript
        else "Transcript:"
    )
    # Appended unconditionally, empty string and all: `"\n".join` then ends the
    # prompt with a bare newline when there was no transcript, which is what
    # the TypeScript builder's `lines.join('\n')` produces for the same input.
    lines.append(format_transcript(transcript))
    return "\n".join(lines)
