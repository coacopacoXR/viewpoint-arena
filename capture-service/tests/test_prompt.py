"""Prompt rendering: chunk labels, timestamps and context fusion.

The system prompt itself is checked against the TypeScript original in
tests/test_typescript_parity.py — this file covers the parts that are built per
request, which is where a Python-specific bug would hide.
"""

from __future__ import annotations

import pytest

from capture_service.prompt import (
    EXTRACTION_SYSTEM_PROMPT,
    build_extraction_user_prompt,
    format_ms,
    format_transcript,
    upcoming_days,
)
from capture_service.schemas import SlideContext
from conftest import make_chunk


@pytest.mark.parametrize(
    ("ms", "expected"),
    [
        (0, "00:00"),
        (1, "00:00"),
        (999, "00:00"),
        (1000, "00:01"),
        (59_999, "00:59"),
        (60_000, "01:00"),
        (4_200, "00:04"),
        (3_600_000, "60:00"),
        (5_400_000, "90:00"),
        (-1, "?"),
        (float("nan"), "?"),
        (float("inf"), "?"),
        (None, "?"),
        ("1000", "?"),
        (True, "?"),
    ],
)
def test_timestamps_render_as_mm_ss(ms: object, expected: str) -> None:
    assert format_ms(ms) == expected  # type: ignore[arg-type]


def test_chunks_are_labelled_positionally() -> None:
    # The labels are what the model is asked to return in `sourceMessageIds`, so
    # they are c0..cN in transcript order and nothing else.
    transcript = [
        make_chunk("First point.", start_ms=0, end_ms=2_000),
        make_chunk("Second point.", speaker_id="speaker-2", start_ms=2_500, end_ms=9_000),
        make_chunk("Third point.", start_ms=65_000, end_ms=125_000),
    ]
    assert format_transcript(transcript) == (
        "c0 [00:00-00:02] speaker-1: First point.\n"
        "c1 [00:02-00:09] speaker-2: Second point.\n"
        "c2 [01:05-02:05] speaker-1: Third point."
    )


def test_an_empty_transcript_renders_as_an_empty_window() -> None:
    assert format_transcript([]) == ""


def test_the_context_comes_before_the_transcript() -> None:
    prompt = build_extraction_user_prompt(
        [make_chunk("The weld will crack.")],
        SlideContext(
            agenda_idx=3,
            slide_title="Rear triangle weld",
            hovered_part_name="Bracket",
            laser_target_part_name="Seat stay",
        ),
        today="2026-09-21",
    )
    assert prompt == (
        "Today's date: 2026-09-21 (Monday)\n"
        f"Next 14 days: {upcoming_days('2026-09-21', 14)}\n"
        "Agenda item 3: Rear triangle weld\n"
        "A speaker was hovering over: Bracket\n"
        "The laser pointer was on: Seat stay\n"
        "\n"
        "Transcript window:\n"
        "c0 [00:00-00:04] speaker-1: The weld will crack."
    )


def test_absent_spatial_context_is_omitted_not_rendered_blank() -> None:
    prompt = build_extraction_user_prompt(
        [make_chunk("Hello.")],
        SlideContext(agenda_idx=0, slide_title="Kickoff"),
        today="2026-09-21",
    )
    assert "hovering" not in prompt
    assert "laser" not in prompt
    assert prompt.startswith("Today's date: 2026-09-21 (Monday)\nNext 14 days: ")
    assert "\nAgenda item 0: Kickoff\n\nTranscript window:\n" in prompt


def test_today_defaults_to_the_current_utc_date() -> None:
    from datetime import datetime, timezone

    prompt = build_extraction_user_prompt(
        [make_chunk("Hello.")], SlideContext(agenda_idx=0, slide_title="Kickoff")
    )
    today = datetime.now(timezone.utc).date().isoformat()
    assert prompt.startswith(f"Today's date: {today} (")


def test_weekday_is_english_and_locale_independent() -> None:
    from capture_service.prompt import weekday_of

    assert weekday_of("2026-09-21") == "Monday"
    assert weekday_of("2026-09-25") == "Friday"
    assert weekday_of("2024-02-29") == "Thursday"
    assert weekday_of("not-a-date") == "unknown"


def test_the_calendar_lists_the_next_days_for_lookup() -> None:
    days = upcoming_days("2026-09-21", 14).split(", ")
    assert len(days) == 14
    assert days[0] == "Tuesday 2026-09-22"
    # "by Friday" said on Monday 21st is the 25th: it must be in the table.
    assert "Friday 2026-09-25" in days
    assert days[-1] == "Monday 2026-10-05"
    assert upcoming_days("nope", 3) == "unknown"


def test_the_system_prompt_asks_for_the_envelope_the_parser_enforces() -> None:
    # Cheap structural checks on the copied prompt: if someone edits the
    # TypeScript original and re-copies it here, these catch a rename that the
    # byte-comparison test would also catch but with a much worse message.
    assert '"cards"' in EXTRACTION_SYSTEM_PROMPT
    for token in ("RISK", "RATIONALE", "ACTION", "Critical", "High", "Medium", "Low"):
        assert token in EXTRACTION_SYSTEM_PROMPT
    assert "no code fences" in EXTRACTION_SYSTEM_PROMPT
    assert 'Do not emit "id" or "timestamp"' in EXTRACTION_SYSTEM_PROMPT
    assert "Do not add any field that is not listed above" in EXTRACTION_SYSTEM_PROMPT


def test_the_prompt_does_not_leak_into_the_system_message() -> None:
    # The system prompt is a constant: no transcript, no context and no
    # deployment detail may end up in it, because it is the one string that is
    # identical for every meeting this service ever processes.
    assert "{" in EXTRACTION_SYSTEM_PROMPT  # the JSON example, and only that
    assert "http" not in EXTRACTION_SYSTEM_PROMPT.lower()


# ─── Grounded sections ─────────────────────────────────────────────────────


def test_the_user_prompt_renders_the_component_list_when_supplied() -> None:
    components = [
        {"id": "left_cup", "name": "Left Ear Cup", "path": "Headphones / Left Ear Cup"},
    ]
    prompt = build_extraction_user_prompt(
        [make_chunk("The cushion is thin.")],
        SlideContext(agenda_idx=0, slide_title="Review"),
        today="2026-09-23",
        components=components,
    )
    assert "Components in this model:" in prompt
    assert "left_cup · Headphones / Left Ear Cup" in prompt


def test_the_user_prompt_renders_pointing_segments_with_seconds() -> None:
    segments = [
        {
            "userId": "u1",
            "userName": "Alice",
            "partId": "left_cushion",
            "partName": "Left Ear Cushion",
            "fromMs": 5000,
            "toMs": 12000,
        }
    ]
    prompt = build_extraction_user_prompt(
        [make_chunk("This one here.")],
        SlideContext(agenda_idx=0, slide_title="Review"),
        today="2026-09-23",
        pointing_segments=segments,
    )
    assert "What people were pointing at:" in prompt
    assert "Alice → Left Ear Cushion (5s–12s)" in prompt


def test_the_user_prompt_renders_the_transcript_hint() -> None:
    hint = [{"speaker": "Alice", "text": "This cushion is thin.", "offsetMs": 8000}]
    prompt = build_extraction_user_prompt(
        [make_chunk("This cushion is thin.")],
        SlideContext(agenda_idx=0, slide_title="Review"),
        today="2026-09-23",
        transcript_hint=hint,
    )
    assert "Speaker transcript (attribution hint" in prompt
    assert "[Alice, t=8s] This cushion is thin." in prompt


def test_the_three_sections_render_in_order() -> None:
    components = [{"id": "x", "name": "X", "path": "X"}]
    segments = [
        {
            "userId": "u1",
            "userName": "A",
            "partId": "x",
            "partName": "X",
            "fromMs": 0,
            "toMs": 1000,
        }
    ]
    hint = [{"speaker": "A", "text": "Hi", "offsetMs": 500}]
    prompt = build_extraction_user_prompt(
        [make_chunk("Hi")],
        SlideContext(agenda_idx=0, slide_title="Review"),
        today="2026-09-23",
        components=components,
        pointing_segments=segments,
        transcript_hint=hint,
    )
    comp_idx = prompt.index("Components in this model:")
    point_idx = prompt.index("What people were pointing at:")
    hint_idx = prompt.index("Speaker transcript")
    transcript_idx = prompt.index("Transcript window:")
    assert comp_idx < point_idx < hint_idx < transcript_idx


def test_the_grounded_sections_are_absent_when_inputs_are_absent() -> None:
    prompt = build_extraction_user_prompt(
        [make_chunk("Hello.")],
        SlideContext(agenda_idx=0, slide_title="Kickoff"),
        today="2026-09-23",
    )
    assert "Components in this model:" not in prompt
    assert "What people were pointing at:" not in prompt
    assert "Speaker transcript" not in prompt


def test_empty_arrays_do_not_render_sections() -> None:
    prompt = build_extraction_user_prompt(
        [make_chunk("Hello.")],
        SlideContext(agenda_idx=0, slide_title="Kickoff"),
        today="2026-09-23",
        components=[],
        pointing_segments=[],
        transcript_hint=[],
    )
    assert "Components in this model:" not in prompt
    assert "What people were pointing at:" not in prompt
    assert "Speaker transcript" not in prompt
