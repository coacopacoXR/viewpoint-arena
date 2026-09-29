"""Batch transcription: chunk building, merging, budgets and laziness.

Every test here runs with no faster-whisper installed, no model on disk and no
GPU. The real backend is exercised by injecting a fake model object through
`FasterWhisperTranscriber(model_factory=…)`, which is the same seam CI relies
on: requirements-whisper.txt is deliberately NOT installed there.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from capture_service.config import load_settings
from capture_service.errors import (
    TranscriberUnavailable,
    TranscriptionFailed,
    TranscriptTooLarge,
)
from capture_service.main import create_app
from capture_service.schemas import TranscriptChunk
from capture_service.transcribe import (
    DEFAULT_SPEAKER_ID,
    MAX_CHUNK_CHARS,
    MAX_CHUNK_SECONDS,
    MAX_TRANSCRIPT_CHARS,
    MAX_TRANSCRIPT_CHUNKS,
    FasterWhisperTranscriber,
    enforce_transcript_budget,
    segments_to_chunks,
)
from conftest import FakeSegment, FakeTranscriber, FakeWhisperModel, make_chunk

SETTINGS = load_settings({})


def transcriber_with(
    segments: list[FakeSegment], **settings_env: str
) -> tuple[FasterWhisperTranscriber, FakeWhisperModel]:
    """A real FasterWhisperTranscriber wrapped around a fake whisper model."""
    model = FakeWhisperModel(segments)
    settings = load_settings(dict(settings_env))
    return FasterWhisperTranscriber(settings, model_factory=lambda: model), model


# ─── Segment → TranscriptChunk ──────────────────────────────────────────────


def test_segments_become_the_typescript_transcript_chunk_shape() -> None:
    chunks = segments_to_chunks([(0.0, 2.5, "The bracket will crack.")])
    assert chunks[0].model_dump(by_alias=True) == {
        "speakerId": DEFAULT_SPEAKER_ID,
        "text": "The bracket will crack.",
        "startMs": 0,
        "endMs": 2500,
    }


def test_times_are_rounded_to_whole_milliseconds_once() -> None:
    chunks = segments_to_chunks([(0.1234, 1.9876, "Spoken.")])
    assert (chunks[0].start_ms, chunks[0].end_ms) == (123, 1988)


def test_a_negative_time_is_clamped_to_zero() -> None:
    # The TypeScript side rejects a chunk with a negative startMs, so a decoder
    # hiccup must not produce one here.
    chunks = segments_to_chunks([(-2.0, -1.0, "Early.")])
    assert (chunks[0].start_ms, chunks[0].end_ms) == (0, 0)


def test_a_swapped_time_is_clamped_not_passed_through() -> None:
    # …and it rejects endMs < startMs, which a swapped pair would produce.
    chunks = segments_to_chunks([(5.0, 3.0, "Swapped.")])
    assert (chunks[0].start_ms, chunks[0].end_ms) == (5000, 5000)


def test_empty_and_whitespace_segments_are_dropped() -> None:
    # Whisper emits these around silence; an empty chunk would render as
    # "c4 [00:12-00:13] speaker-1: " and burn prompt budget.
    chunks = segments_to_chunks(
        [
            (0.0, 1.0, ""),
            (1.0, 2.0, "   "),
            (2.0, 3.0, "Real speech."),
            (3.0, 4.0, "\n"),
        ]
    )
    assert [c.text for c in chunks] == ["Real speech."]
    assert (chunks[0].start_ms, chunks[0].end_ms) == (2000, 3000)


def test_a_silent_recording_produces_no_chunks() -> None:
    assert segments_to_chunks([]) == []
    assert segments_to_chunks([(0.0, 1.0, "")]) == []


def test_every_chunk_carries_the_single_batch_speaker_label() -> None:
    chunks = segments_to_chunks(
        [(0.0, 1.0, "One."), (60.0, 61.0, "Two."), (120.0, 121.0, "Three.")]
    )
    assert {c.speaker_id for c in chunks} == {DEFAULT_SPEAKER_ID}


def test_the_speaker_label_can_be_overridden() -> None:
    chunks = segments_to_chunks([(0.0, 1.0, "One.")], speaker_id="host")
    assert chunks[0].speaker_id == "host"


# ─── Merging ────────────────────────────────────────────────────────────────


def test_short_consecutive_segments_are_merged_into_one_chunk() -> None:
    chunks = segments_to_chunks(
        [(0.0, 1.0, "The weld"), (1.0, 2.0, "will crack"), (2.0, 3.0, "under load.")]
    )
    assert chunks == [
        TranscriptChunk(
            speaker_id=DEFAULT_SPEAKER_ID,
            text="The weld will crack under load.",
            start_ms=0,
            end_ms=3000,
        )
    ]


def test_merging_stops_at_the_character_bound() -> None:
    word = "x" * (MAX_CHUNK_CHARS // 4)
    chunks = segments_to_chunks(
        [(float(i), float(i + 1), word) for i in range(12)]
    )
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk.text) <= MAX_CHUNK_CHARS


def test_merging_stops_at_the_time_bound() -> None:
    # 90s apart, so every segment's span with its predecessor exceeds the bound
    # and each one lands in its own chunk.
    chunks = segments_to_chunks(
        [(i * 90.0, i * 90.0 + 1.0, f"Point {i}.") for i in range(6)]
    )
    assert len(chunks) == 6
    assert [(c.start_ms, c.end_ms) for c in chunks] == [
        (i * 90_000, i * 90_000 + 1_000) for i in range(6)
    ]


def test_no_merged_chunk_exceeds_the_time_bound() -> None:
    # The bound is checked before a segment is absorbed, so a merged chunk is
    # never longer than MAX_CHUNK_SECONDS unless ONE segment already was.
    segments = [(i * 3.0, i * 3.0 + 2.0, f"Point {i}.") for i in range(40)]
    for chunk in segments_to_chunks(segments):
        assert (chunk.end_ms - chunk.start_ms) / 1000 <= MAX_CHUNK_SECONDS


def test_a_single_segment_longer_than_the_bound_stays_whole() -> None:
    # Splitting inside a segment would mean inventing a boundary Whisper did
    # not report, so an over-long segment is passed through as one chunk.
    chunks = segments_to_chunks([(0.0, 300.0, "One very long segment.")])
    assert len(chunks) == 1
    assert chunks[0].end_ms == 300_000


def test_a_merged_chunk_spans_the_first_and_last_segment_it_absorbed() -> None:
    chunks = segments_to_chunks([(1.0, 2.0, "A."), (2.0, 3.0, "B."), (90.0, 91.0, "C.")])
    assert [(c.text, c.start_ms, c.end_ms) for c in chunks] == [
        ("A. B.", 1000, 3000),
        ("C.", 90000, 91000),
    ]


def test_merging_never_reorders_or_drops_speech() -> None:
    segments = [(float(i), float(i) + 0.5, f"sentence {i}") for i in range(200)]
    chunks = segments_to_chunks(segments)
    rebuilt = " ".join(chunk.text for chunk in chunks)
    assert rebuilt == " ".join(f"sentence {i}" for i in range(200))
    assert chunks[0].start_ms == 0
    assert chunks[-1].end_ms == 199_500


# ─── Prompt budget ──────────────────────────────────────────────────────────


def test_a_normal_transcript_is_within_budget() -> None:
    enforce_transcript_budget([make_chunk("Short meeting.")])


def test_too_many_chunks_is_rejected_before_the_llm_is_called() -> None:
    with pytest.raises(TranscriptTooLarge):
        enforce_transcript_budget([make_chunk("a") for _ in range(MAX_TRANSCRIPT_CHUNKS + 1)])


def test_too_much_text_is_rejected_before_the_llm_is_called() -> None:
    # One chunk per char-limit slice, so the CHUNK count is legal and only the
    # character total breaks the budget.
    per_chunk = MAX_CHUNK_CHARS
    count = MAX_TRANSCRIPT_CHARS // per_chunk + 2
    with pytest.raises(TranscriptTooLarge):
        enforce_transcript_budget([make_chunk("x" * per_chunk) for _ in range(count)])


def test_the_budget_limits_match_the_cloud_extraction_endpoint() -> None:
    # api/capture/extract.ts: MAX_CHUNKS = 2000, MAX_TRANSCRIPT_CHARS = 200_000.
    # A recording that is too long for one path must be too long for both.
    assert MAX_TRANSCRIPT_CHUNKS == 2000
    assert MAX_TRANSCRIPT_CHARS == 200_000


# ─── The faster-whisper backend ─────────────────────────────────────────────


def test_the_backend_converts_a_fake_model_s_segments(tmp_path: Path) -> None:
    backend, model = transcriber_with(
        [FakeSegment(0.0, 1.5, "The bracket"), FakeSegment(1.5, 3.0, "will crack.")]
    )
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"not really audio")

    chunks = backend.transcribe(audio)

    assert [c.text for c in chunks] == ["The bracket will crack."]
    assert model.calls == [{"audio": str(audio), "language": None, "vad_filter": True}]


def test_the_configured_language_is_passed_to_whisper(tmp_path: Path) -> None:
    backend, model = transcriber_with(
        [FakeSegment(0.0, 1.0, "Hallo.")], CAPTURE_WHISPER_LANGUAGE="de"
    )
    audio = tmp_path / "m.wav"
    audio.write_bytes(b"x")
    backend.transcribe(audio)
    assert model.calls[0]["language"] == "de"


def test_vad_filter_is_enabled_so_silence_does_not_hallucinate(tmp_path: Path) -> None:
    # Without vad_filter, Whisper invents text for silent stretches ("Thank
    # you.", "you", ".") — fatal for the live panel, which would show a
    # hallucination every 8 s. The flag is passed on every transcribe() call,
    # batch and live alike.
    backend, model = transcriber_with([FakeSegment(0.0, 1.0, "Word.")])
    audio = tmp_path / "m.wav"
    audio.write_bytes(b"x")
    backend.transcribe(audio)
    assert model.calls[0]["vad_filter"] is True


def test_the_model_is_loaded_once_and_cached(tmp_path: Path) -> None:
    loads: list[int] = []
    model = FakeWhisperModel([FakeSegment(0.0, 1.0, "Word.")])

    def factory() -> FakeWhisperModel:
        loads.append(1)
        return model

    backend = FasterWhisperTranscriber(SETTINGS, model_factory=factory)
    audio = tmp_path / "m.wav"
    audio.write_bytes(b"x")

    assert backend.is_loaded() is False
    backend.transcribe(audio)
    backend.transcribe(audio)
    backend.transcribe(audio)

    assert len(loads) == 1
    assert backend.is_loaded() is True


def test_a_decoder_failure_becomes_a_transcription_failed(tmp_path: Path) -> None:
    model = FakeWhisperModel(
        error=RuntimeError("Invalid data found when processing input")
    )
    backend = FasterWhisperTranscriber(SETTINGS, model_factory=lambda: model)
    audio = tmp_path / "m.wav"
    audio.write_bytes(b"x")

    with pytest.raises(TranscriptionFailed) as error:
        backend.transcribe(audio)

    assert error.value.status == 500
    assert error.value.code == "transcription_failed"
    # The decoder's own text is not repeated: it can carry the file path, and
    # the type name is enough to know what to look for in the log.
    assert "Invalid data" not in error.value.message
    assert "RuntimeError" in error.value.message


def test_a_model_load_failure_becomes_transcriber_unavailable(tmp_path: Path) -> None:
    def factory() -> object:
        raise TranscriberUnavailable(
            "faster-whisper could not load model 'base.en' on device 'cuda'"
        )

    backend = FasterWhisperTranscriber(SETTINGS, model_factory=factory)
    audio = tmp_path / "m.wav"
    audio.write_bytes(b"x")

    with pytest.raises(TranscriberUnavailable) as error:
        backend.transcribe(audio)
    assert error.value.status == 503
    assert error.value.code == "transcriber_unavailable"


def test_the_backend_name_reports_the_configured_model() -> None:
    backend, _ = transcriber_with([], CAPTURE_WHISPER_MODEL="small.en")
    assert backend.name == "faster-whisper:small.en"


# ─── Laziness: no model, no GPU, no import ──────────────────────────────────


def test_building_the_transcriber_does_not_import_faster_whisper() -> None:
    FasterWhisperTranscriber(SETTINGS)
    assert "faster_whisper" not in sys.modules


def test_building_the_app_does_not_import_faster_whisper() -> None:
    # This is the structural guarantee the CI job depends on: requirements.txt
    # does not install faster-whisper, so a top-level import anywhere in the
    # request path would be a ModuleNotFoundError in CI, not a slow test.
    create_app(SETTINGS, FakeTranscriber(), None)
    assert "faster_whisper" not in sys.modules


def test_the_service_package_imports_no_ml_dependency() -> None:
    for module in list(sys.modules):
        assert not module.startswith(("faster_whisper", "ctranslate2", "torch", "onnxruntime")), module


@pytest.mark.skipif(
    importlib.util.find_spec("faster_whisper") is not None,
    reason="faster-whisper is installed locally; the missing-dependency path cannot be exercised",
)
def test_a_missing_faster_whisper_says_how_to_install_it(tmp_path: Path) -> None:
    backend = FasterWhisperTranscriber(SETTINGS)
    audio = tmp_path / "m.wav"
    audio.write_bytes(b"x")

    with pytest.raises(TranscriberUnavailable) as error:
        backend.transcribe(audio)

    message = error.value.message
    assert "requirements-whisper.txt" in message
    assert error.value.status == 503
