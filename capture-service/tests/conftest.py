"""Shared fakes and fixtures.

The whole suite runs with NO GPU, NO downloaded Whisper model, NO Ollama and NO
network. That is not an aspiration, it is enforced by the environment: CI
installs requirements-dev.txt and deliberately not requirements-whisper.txt, so
`import faster_whisper` would fail the suite outright.

Two seams make that possible, and both are in the production code rather than
patched in from here:

  * transcribe.Transcriber / FasterWhisperTranscriber(model_factory=…)
  * ollama.LlmClient / OllamaClient(transport=httpx.MockTransport(…))

`create_app(settings, transcriber, llm)` takes both as arguments, so a test
builds a fully wired service without monkeypatching a single module global.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import httpx
import pytest
from fastapi.testclient import TestClient

from capture_service.config import Settings, load_settings
from capture_service.main import create_app
from capture_service.prompt import EXTRACTION_JSON_SCHEMA
from capture_service.schemas import TranscriptChunk
from capture_service.transcribe import DEFAULT_SPEAKER_ID

# Not a real recording: it never reaches a decoder, because every test injects
# FakeTranscriber. It only has to be non-empty bytes with a plausible suffix.
FAKE_AUDIO = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 64

# A transcript chunk carrying a sentinel. Tests assert this string never
# appears in an error response or a log line: it stands in for the proprietary
# content a real transcript holds.
SECRET_SPEECH = "SENTINEL-the-yield-blocker-nobody-may-echo"


def make_chunk(
    text: str = "The bracket weld will crack under load.",
    *,
    speaker_id: str = DEFAULT_SPEAKER_ID,
    start_ms: int = 0,
    end_ms: int = 4200,
) -> TranscriptChunk:
    return TranscriptChunk(
        speaker_id=speaker_id, text=text, start_ms=start_ms, end_ms=end_ms
    )


def sentinel_chunk() -> TranscriptChunk:
    return make_chunk(SECRET_SPEECH)


def wire_chunk(
    text: str = "The bracket weld will crack under load.",
    *,
    speaker_id: str = DEFAULT_SPEAKER_ID,
    start_ms: int = 0,
    end_ms: int = 4200,
) -> dict[str, Any]:
    """`make_chunk` as a caller spells it in a JSON body: camelCase, plain dict.

    /extract and /summarize take a transcript in the request body rather than
    producing one from audio, so their tests build the wire shape directly.
    """
    return {
        "speakerId": speaker_id,
        "text": text,
        "startMs": start_ms,
        "endMs": end_ms,
    }


def sentinel_wire_chunk() -> dict[str, Any]:
    return wire_chunk(SECRET_SPEECH)


# A card that satisfies every rule the parser enforces, in the shape the
# extraction prompt asks for (no id, no timestamp: the app mints both).
VALID_CARD: dict[str, Any] = {
    "type": "RISK",
    "title": "Bracket weld cracks under load",
    "description": "The reviewer said the weld will crack before the yield target.",
    "agentId": "speaker-1",
    "details": {"priority": "High", "impact": "Warranty returns"},
}


def card(**overrides: Any) -> dict[str, Any]:
    """A copy of VALID_CARD with top-level overrides applied.

    `details` REPLACES the whole sub-object rather than merging into it, so a
    test can drop a required field (`card(details={})`) instead of only being
    able to add to one. Pass `{**VALID_CARD["details"], ...}` to merge by hand.
    """
    merged = dict(VALID_CARD)
    merged.update(overrides)
    return merged


def cards_payload(*cards: dict[str, Any]) -> str:
    """The exact reply the extraction prompt asks a model for."""
    return json.dumps({"cards": list(cards)})


def wire_card(**overrides: Any) -> dict[str, Any]:
    """A card in the FULL wire shape, as a caller sends it back to /summarize.

    VALID_CARD is what a MODEL emits: no `id`, no `timestamp`, because the app
    mints both. A card arriving at /summarize has already been through a
    provider and carries them, and `InsightCard` requires both — so a test that
    posted VALID_CARD would be testing the 400, not the route.
    """
    return {"id": "insight-1", "timestamp": 1_700_000_000_000, **VALID_CARD, **overrides}


# ─── Fakes ──────────────────────────────────────────────────────────────────


class FakeTranscriber:
    """Stands in for FasterWhisperTranscriber. Satisfies transcribe.Transcriber."""

    name = "fake-whisper"

    def __init__(
        self,
        chunks: Sequence[TranscriptChunk] | None = None,
        *,
        error: Exception | None = None,
        loaded: bool = True,
    ) -> None:
        self.chunks = list(chunks) if chunks is not None else [make_chunk()]
        self.error = error
        self.loaded = loaded
        self.paths: list[Path] = []
        self.sizes: list[int] = []

    def is_loaded(self) -> bool:
        return self.loaded

    def transcribe(self, audio_path: Path) -> list[TranscriptChunk]:
        path = Path(audio_path)
        # Recorded while the file still exists: main.py deletes it as soon as
        # transcribe() returns, and a test needs to know what was spooled.
        self.paths.append(path)
        self.sizes.append(path.stat().st_size if path.exists() else -1)
        if self.error is not None:
            raise self.error
        return list(self.chunks)


class FakeLlm:
    """Stands in for OllamaClient. Satisfies ollama.LlmClient."""

    name = "fake-llm"

    def __init__(
        self,
        reply: str | None = None,
        *,
        error: Exception | None = None,
    ) -> None:
        self.reply = cards_payload(VALID_CARD) if reply is None else reply
        self.error = error
        self.calls: list[tuple[str, str]] = []
        # Recorded separately from `calls` because the schema is the one part
        # of an LLM request a test cannot infer from the prompts: /summarize
        # must send None (free markdown) and /extract must not.
        self.schemas: list[dict[str, object] | None] = []

    def complete(
        self,
        system: str,
        user: str,
        *,
        schema: dict[str, object] | None = EXTRACTION_JSON_SCHEMA,
    ) -> str:
        self.calls.append((system, user))
        self.schemas.append(schema)
        if self.error is not None:
            raise self.error
        return self.reply

    @property
    def call_count(self) -> int:
        return len(self.calls)

    @property
    def last_system_prompt(self) -> str:
        return self.calls[-1][0]

    @property
    def last_user_prompt(self) -> str:
        return self.calls[-1][1]

    @property
    def last_schema(self) -> dict[str, object] | None:
        return self.schemas[-1]


@dataclass
class FakeSegment:
    """The part of faster_whisper.Segment this service reads."""

    start: float
    end: float
    text: str


class FakeWhisperModel:
    """Stands in for faster_whisper.WhisperModel, via model_factory injection."""

    def __init__(
        self,
        segments: Iterable[FakeSegment] | None = None,
        *,
        error: Exception | None = None,
    ) -> None:
        self.segments = list(segments) if segments is not None else []
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def transcribe(self, audio: str, language: str | None = None, vad_filter: bool = False) -> Any:
        self.calls.append({"audio": audio, "language": language, "vad_filter": vad_filter})
        if self.error is not None:
            raise self.error

        def generate() -> Any:
            # The real API returns a GENERATOR: the work happens while it is
            # consumed. Yielding keeps the fake honest about that, so a
            # transcriber that stopped iterating inside its try/except would
            # still be caught by the tests.
            yield from self.segments

        return generate(), {"language": language or "en", "duration": 12.34}


# ─── Service bundle ─────────────────────────────────────────────────────────


@dataclass
class Service:
    """A wired app plus the fakes it was built with, and helpers to call it."""

    client: TestClient
    transcriber: FakeTranscriber
    llm: FakeLlm
    settings: Settings
    temp_paths: list[Path] = field(default_factory=list)

    def post_capture(
        self,
        audio: bytes = FAKE_AUDIO,
        *,
        filename: str = "meeting.wav",
        content_type: str = "audio/wav",
        fields: dict[str, Any] | None = None,
        include_audio: bool = True,
    ) -> httpx.Response:
        files = {"audio": (filename, audio, content_type)} if include_audio else {}
        return self.client.post("/capture", files=files, data=fields or {})

    def post_transcribe(
        self, audio: bytes = FAKE_AUDIO, *, filename: str = "meeting.wav"
    ) -> httpx.Response:
        return self.client.post(
            "/transcribe", files={"audio": (filename, audio, "audio/wav")}
        )

    def post_extract(self, body: dict[str, Any] | None = None) -> httpx.Response:
        """POST a JSON body to /extract, merged over a one-chunk transcript."""
        payload: dict[str, Any] = {"transcript": [wire_chunk()]}
        payload.update(body or {})
        return self.client.post("/extract", json=payload)

    def post_summarize(self, body: dict[str, Any] | None = None) -> httpx.Response:
        """POST a JSON body to /summarize, merged over a one-chunk transcript.

        Merging keeps `post_summarize({"cards": [...]})` a request with
        something in it. To exercise the both-empty refusal, pass
        `{"transcript": [], "cards": []}` or post through `client` directly.
        """
        payload: dict[str, Any] = {"transcript": [wire_chunk()]}
        payload.update(body or {})
        return self.client.post("/summarize", json=payload)


@pytest.fixture
def make_service() -> Callable[..., Service]:
    """Build a service from an environment mapping and/or replacement fakes."""

    def build(
        *,
        env: dict[str, str] | None = None,
        transcriber: FakeTranscriber | None = None,
        llm: FakeLlm | None = None,
    ) -> Service:
        resolved_transcriber = transcriber or FakeTranscriber()
        resolved_llm = llm or FakeLlm()
        settings = load_settings(env or {})
        app = create_app(settings, resolved_transcriber, resolved_llm)
        return Service(
            client=TestClient(app),
            transcriber=resolved_transcriber,
            llm=resolved_llm,
            settings=settings,
        )

    return build


@pytest.fixture
def service(make_service: Callable[..., Service]) -> Iterable[Service]:
    """The default service: one chunk of transcript, one valid card back."""
    bundle = make_service()
    with bundle.client:
        yield bundle


@pytest.fixture
def client(service: Service) -> TestClient:
    return service.client


@pytest.fixture
def settings() -> Settings:
    """Settings from the documented defaults, with no environment at all."""
    return load_settings({})
