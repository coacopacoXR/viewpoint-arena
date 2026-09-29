"""capture-service — local, batch-mode meeting capture for Viewpoint Arena.

Implements T4.1–T4.3 of docs/plan/08-task-breakdown.md and the "batch before
live" MVP in docs/local-capture-plan.md: a full meeting recording goes in,
speaker-labelled transcript chunks come out of faster-whisper, one LLM pass
over that transcript produces InsightCard[], and nothing — no audio, no
transcript, no model output — ever leaves the network the service runs on.

This package deliberately imports no ML dependency at import time. Whisper is
loaded lazily behind `transcribe.Transcriber` and Ollama behind
`ollama.LlmClient`, so the whole test suite runs with no GPU, no downloaded
model and no network.
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
