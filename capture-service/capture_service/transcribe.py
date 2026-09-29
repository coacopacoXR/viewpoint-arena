"""Batch transcription: faster-whisper behind a swappable interface.

docs/local-capture-plan.md's "Strong suggestion for the first iteration" is
explicit that the MVP is BATCH, not streaming: the browser records the whole
meeting, uploads the file, and this module runs Whisper over it once. There is
no chunk buffering, no partial-transcript broadcast and no WebSocket here —
that is T4.7, deliberately sequenced after the offline path is solid.

The `Transcriber` protocol exists for two reasons:

  1. TESTS RUN WITHOUT WHISPER. `FasterWhisperTranscriber` imports
     faster_whisper inside `_load_model`, on first use, so nothing in this
     package pulls in ctranslate2/onnxruntime at import time and the test suite
     needs no model download, no GPU and no network. CI installs
     requirements-dev.txt and NOT requirements-whisper.txt — if any code path
     grew a top-level whisper import, CI would fail with ModuleNotFoundError.
     That is the guarantee, enforced by the environment rather than by a
     comment.
  2. The plan lists alternatives (whisper.cpp, WhisperX, the
     whisper-asr-webservice container). Swapping one in means implementing
     `transcribe()` and passing it to `create_app(transcriber=...)`; no route,
     schema or parser changes.

Speaker labels: faster-whisper does NOT diarize. Batch mode therefore emits one
label for the whole recording (DEFAULT_SPEAKER_ID) rather than inventing speaker
turns — a fabricated speaker id would flow into InsightCard.agentId and be
displayed as "who said this" in the Manager workspace, which is worse than an
honest single label. Real diarization is WhisperX territory and is an open
question in docs/local-capture-plan.md §"Open questions".
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Protocol, Sequence

from .config import Settings
from .errors import (
    TranscriberUnavailable,
    TranscriptionFailed,
    TranscriptTooLarge,
    excerpt,
)
from .schemas import TranscriptChunk

# Every chunk from a batch transcription carries this label. See the module
# docstring: Whisper does not diarize, and guessing would be a lie that the UI
# repeats.
DEFAULT_SPEAKER_ID = "speaker-1"

# Whisper emits one segment per sentence-ish pause, which for a 90-minute review
# is thousands of chunks. The extraction prompt labels every chunk (c0, c1, …)
# and the whole thing goes to a 7B model in one pass, so consecutive segments
# are merged up to these bounds. Neither bound changes what was said — only how
# it is grouped — and merging keeps a long meeting inside the prompt budget
# instead of failing with transcript_too_large.
MAX_CHUNK_CHARS = 400
MAX_CHUNK_SECONDS = 60.0

# The same ceiling api/capture/extract.ts enforces on the cloud path, so a
# recording that is too long for this service is too long for either.
MAX_TRANSCRIPT_CHARS = 200_000
MAX_TRANSCRIPT_CHUNKS = 2_000


class Transcriber(Protocol):
    """Anything that can turn an audio file into speaker-labelled chunks."""

    @property
    def name(self) -> str:
        """Human-readable backend name, reported by GET /health."""
        ...

    def transcribe(self, audio_path: Path) -> list[TranscriptChunk]:
        """Transcribe a complete audio file. Blocking; runs in a threadpool."""
        ...

    def is_loaded(self) -> bool:
        """True once the model is in memory. Must NOT trigger a load."""
        ...


def segments_to_chunks(
    segments: Iterable[tuple[float, float, str]],
    speaker_id: str = DEFAULT_SPEAKER_ID,
) -> list[TranscriptChunk]:
    """Convert (start_seconds, end_seconds, text) segments into merged chunks.

    Milliseconds are rounded once, here, so downstream code (and the TypeScript
    `TranscriptChunk` shape it feeds) only ever sees whole numbers. A segment
    whose end precedes its start is clamped rather than dropped: Whisper does
    not emit those, but a swapped pair must not produce a chunk that the
    TypeScript side would reject (`endMs < startMs`).
    """
    chunks: list[TranscriptChunk] = []
    texts: list[str] = []
    start_ms = 0
    end_ms = 0

    def flush() -> None:
        if not texts:
            return
        chunks.append(
            TranscriptChunk(
                speaker_id=speaker_id,
                text=" ".join(texts),
                start_ms=start_ms,
                end_ms=end_ms,
            )
        )
        texts.clear()

    for raw_start, raw_end, raw_text in segments:
        text = str(raw_text).strip()
        if not text:
            # Whisper emits empty and hallucinated-whitespace segments around
            # silence; an empty chunk would render as "c4 [00:12-00:13]
            # speaker-1: " and waste prompt budget.
            continue
        seg_start = max(0, int(round(float(raw_start) * 1000)))
        seg_end = max(seg_start, int(round(float(raw_end) * 1000)))

        if not texts:
            start_ms, end_ms = seg_start, seg_end
            texts.append(text)
            continue

        merged_chars = sum(len(item) for item in texts) + 1 + len(text)
        merged_seconds = (seg_end - start_ms) / 1000
        if merged_chars > MAX_CHUNK_CHARS or merged_seconds > MAX_CHUNK_SECONDS:
            flush()
            start_ms, end_ms = seg_start, seg_end
            texts.append(text)
        else:
            texts.append(text)
            end_ms = seg_end

    flush()
    return chunks


def enforce_transcript_budget(transcript: Sequence[TranscriptChunk]) -> None:
    """Reject a transcript that will not fit the extraction prompt.

    Checked before the LLM call, not after: a 7B model on CPU takes seconds per
    extraction and would fail or truncate anyway.
    """
    if len(transcript) > MAX_TRANSCRIPT_CHUNKS:
        raise TranscriptTooLarge(
            f"at most {MAX_TRANSCRIPT_CHUNKS} chunks", len(transcript)
        )
    total_chars = sum(len(chunk.text) for chunk in transcript)
    if total_chars > MAX_TRANSCRIPT_CHARS:
        raise TranscriptTooLarge(
            f"at most {MAX_TRANSCRIPT_CHARS} characters", total_chars
        )


def load_whisper_model(settings: Settings) -> object:
    """Import faster-whisper and build a WhisperModel. The ONLY import site.

    Split out from the transcriber so the laziness is a property of one small
    function, and so a test can substitute a fake model without touching the
    import.
    """
    try:
        from faster_whisper import WhisperModel  # noqa: PLC0415 — deliberately lazy
    except ImportError as exc:
        raise TranscriberUnavailable(
            "faster-whisper is not installed, so this capture-service cannot "
            "transcribe. Install the transcription extra with "
            "`pip install -r requirements-whisper.txt` (it pulls ctranslate2 "
            "and downloads the model on first use), or run the service with an "
            "injected Transcriber."
        ) from exc

    try:
        return WhisperModel(
            settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
        )
    except Exception as exc:  # noqa: BLE001 — any load failure is the same 503
        # Safe to quote the loader here, unlike everywhere else: this runs
        # before any audio exists, so the text can only describe the model,
        # device or download — never a transcript.
        raise TranscriberUnavailable(
            f"faster-whisper could not load model "
            f"{settings.whisper_model!r} on device {settings.whisper_device!r} "
            f"with compute type {settings.whisper_compute_type!r}: "
            f"{type(exc).__name__}: {excerpt(str(exc))}. First use downloads "
            f"the model, so check network access to huggingface.co, disk "
            f"space, and that CAPTURE_WHISPER_DEVICE matches the hardware "
            f"(cuda needs a GPU; cpu always works)."
        ) from None


class FasterWhisperTranscriber:
    """Batch transcriber backed by faster-whisper. Satisfies `Transcriber`.

    The model is loaded on first `transcribe()` call and cached for the process
    lifetime: loading a 7B-class Whisper model takes seconds and hundreds of MB
    of RAM, which must not happen per request, but must also not happen at
    import time (that is what makes the test suite runnable with no model).
    """

    def __init__(
        self,
        settings: Settings,
        model_factory: object | None = None,
    ) -> None:
        self._settings = settings
        self._model_factory = model_factory or (lambda: load_whisper_model(settings))
        self._model: object | None = None

    @property
    def name(self) -> str:
        return f"faster-whisper:{self._settings.whisper_model}"

    def is_loaded(self) -> bool:
        return self._model is not None

    def transcribe(self, audio_path: Path) -> list[TranscriptChunk]:
        model = self._ensure_model()
        try:
            # faster-whisper returns (segments, info) where segments is a
            # GENERATOR: the work happens while iterating, so the list
            # comprehension must stay inside the try.
            #
            # vad_filter=True runs Silero VAD before Whisper, suppressing the
            # hallucinated text Whisper invents for silent stretches ("Thank
            # you.", "you", "."). Without it the live panel would show a
            # hallucination every 8 s. Silero is bundled with faster-whisper;
            # onnxruntime is already a dependency, so no new package is needed.
            # This also applies to batch /capture — fine, because the batch
            # path was already dropping empty segments, and VAD just makes the
            # transcript cleaner.
            segments, _info = model.transcribe(  # type: ignore[attr-defined]
                str(audio_path),
                language=self._settings.whisper_language,
                vad_filter=True,
            )
            raw = [
                (float(segment.start), float(segment.end), str(segment.text))
                for segment in segments
            ]
        except Exception as exc:  # noqa: BLE001 — any failure is the same 500
            # Type name only. A whisper failure message can contain the audio
            # path or decoder output, and neither belongs in a log line that an
            # operator might paste next to a transcript.
            raise TranscriptionFailed(
                f"Transcription failed with {type(exc).__name__}. The upload "
                f"reached the decoder, so the usual causes are a file ffmpeg "
                f"cannot decode (re-export it as WAV or Opus and retry), a "
                f"model that ran out of memory on this device, or a "
                f"CAPTURE_WHISPER_COMPUTE_TYPE the device does not support. "
                f"The recording was deleted after this attempt, so reproduce it "
                f"by re-uploading the same file."
            ) from None
        return segments_to_chunks(raw)

    def _ensure_model(self) -> object:
        if self._model is None:
            self._model = self._model_factory()
        return self._model
