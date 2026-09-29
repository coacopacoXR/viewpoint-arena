"""Failure taxonomy for capture-service.

Two rules shape every class in this module, and they are the reason it exists
as a single module rather than ad-hoc `HTTPException`s in the routes.

1. `code` is machine-readable and is the ONLY part of a failure that reaches an
   HTTP response body (plus the small, non-sensitive extras a subclass opts in
   to via `response_extras()`). The vocabulary matches the TypeScript capture
   API — api/capture/extract.ts and lib/connectors/capture/extractClient.ts —
   so the browser client (T4.4) can translate a failure from either service
   with one switch statement.

2. `message` is transcript-free BY CONSTRUCTION. Nothing here may quote the
   model's output, the transcript, the uploaded filename or a credential,
   because messages get logged and a logged traceback is a leak. This is a
   deliberate divergence from lib/connectors/capture/parseInsightCards.ts,
   whose messages quote a 120-char snippet of model output and are kept safe
   only because api/capture/extract.ts forwards `reason` and never `message`.
   Here the message itself is safe, so there is no code path that has to
   remember not to log it. Where an upstream detail genuinely helps an
   operator (Ollama's own short `error` string, a whisper load failure) it is
   bounded, whitespace-flattened and stays in the server log.

Status codes mirror the TypeScript endpoint where the same situation exists:
413 for anything over a size limit, 422 for a well-formed request whose model
output could not be used, 502/503/504 for upstream problems, 500 for our own.
"""

from __future__ import annotations

from typing import Literal

# Closed vocabulary, identical to CaptureParseFailureReason in
# lib/connectors/capture/parseInsightCards.ts. tests/test_typescript_parity.py
# asserts the two lists have not drifted.
ParseFailureReason = Literal[
    # The reply was wrapped in a ``` fence that was never closed.
    "markdown_fenced",
    # The reply was natural language, not JSON.
    "prose",
    # The reply started as JSON and stopped mid-value (usually the token limit).
    "truncated_json",
    # The reply was almost-JSON that does not parse.
    "malformed_json",
    # Valid JSON, but not the `{ "cards": [...] }` envelope.
    "wrong_envelope",
    # A key that is not part of InsightCard / InsightDetails.
    "extra_fields",
    # A known key holding a missing, mistyped or out-of-range value.
    "invalid_card",
]

PARSE_FAILURE_REASONS: frozenset[str] = frozenset(
    {
        "markdown_fenced",
        "prose",
        "truncated_json",
        "malformed_json",
        "wrong_envelope",
        "extra_fields",
        "invalid_card",
    }
)

# Cap on any upstream text repeated into a log line, matching
# MAX_BODY_EXCERPT in lib/connectors/capture/ollamaDirect.ts.
MAX_LOG_EXCERPT = 300


def excerpt(text: str, limit: int = MAX_LOG_EXCERPT) -> str:
    """Bounded, whitespace-flattened excerpt for a SERVER LOG line only.

    Flattening is not cosmetic: a value containing newlines could otherwise
    forge extra log lines. Never put the result in an HTTP response.
    """
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else f"{flat[:limit]}…"


class CaptureServiceError(Exception):
    """Base class for every failure this service reports on purpose.

    Subclasses set `code` and `status`; `main.create_app` turns any instance
    into a JSON response without ever forwarding `message`.
    """

    code: str = "capture_error"
    status: int = 500

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def response_extras(self) -> dict[str, object]:
        """Non-sensitive additions to the response body. Empty by default."""
        return {}

    def response_body(self) -> dict[str, object]:
        body: dict[str, object] = {"error": self.code}
        body.update(self.response_extras())
        return body


class ConfigError(CaptureServiceError):
    """Environment configuration is unusable. Raised at start-up, not per request."""

    code = "config_invalid"
    status = 500


class UploadTooLarge(CaptureServiceError):
    """The upload exceeded CAPTURE_MAX_UPLOAD_BYTES.

    Detected while streaming the body to a temp file, so an oversized meeting
    is rejected before a single second of GPU or CPU time is spent on it.
    """

    code = "upload_too_large"
    status = 413

    def __init__(self, max_bytes: int) -> None:
        super().__init__(
            f"The uploaded recording is larger than the configured limit of "
            f"{max_bytes} bytes (CAPTURE_MAX_UPLOAD_BYTES). Split the meeting "
            f"into shorter recordings or raise the limit."
        )
        self.max_bytes = max_bytes

    def response_extras(self) -> dict[str, object]:
        # A number, not content: safe, and it tells the client the exact
        # ceiling without a second round trip.
        return {"maxUploadBytes": self.max_bytes}


class EmptyUpload(CaptureServiceError):
    """The upload contained zero bytes."""

    code = "empty_upload"
    status = 400

    def __init__(self) -> None:
        super().__init__("The uploaded recording was empty (0 bytes).")


class TranscriptTooLarge(CaptureServiceError):
    """The transcript exceeded the prompt budget.

    Same limits as api/capture/extract.ts, so a recording that is too long for
    this service is also too long for the cloud path — one behaviour to learn.
    """

    code = "transcript_too_large"
    status = 413

    def __init__(self, limit: str, actual: int) -> None:
        super().__init__(
            f"The transcript exceeded the extraction budget ({limit}: "
            f"{actual} actual). Shorten the recording or raise the merge "
            f"window in capture_service/transcribe.py."
        )


class EmptyTranscript(CaptureServiceError):
    """Whisper ran successfully and found no speech.

    422 rather than the 400 that api/capture/extract.ts uses for
    `empty_transcript`: there the client sent an empty array (a client bug),
    here the request was well-formed and the recording simply had nothing
    recognisable in it.
    """

    code = "empty_transcript"
    status = 422

    def __init__(self) -> None:
        super().__init__(
            "Transcription produced no speech. Check that the recording "
            "contains audio and that CAPTURE_WHISPER_LANGUAGE matches the "
            "language spoken (leave it unset to auto-detect)."
        )


class EmptyTranscriptRequest(CaptureServiceError):
    """A JSON request body carried no transcript chunks at all.

    Shares the `empty_transcript` code with EmptyTranscript above — one code
    for "there was nothing to extract from", so lib/connectors/capture/
    extractClient.ts and local.ts keep a single `case` for it — but NOT its
    status. EmptyTranscript is 422: the request was well-formed and Whisper
    genuinely found no speech in it. This one is 400, because the client sent
    an empty array and nothing else went wrong; that is the status
    api/capture/extract.ts uses for the same mistake on the cloud path, and
    matching it means a caller sees one behaviour whichever provider answered.

    Kept as a separate class rather than a `status` argument on
    EmptyTranscript: the two have different messages pointing at different
    fixes (check the recording vs. check the caller), and errors.py's rule is
    that a class is a situation, not a parameterisation of one.
    """

    code = "empty_transcript"
    status = 400

    def __init__(self) -> None:
        super().__init__(
            "The request body contained no transcript chunks. Extraction "
            "needs at least one chunk; the caller sent an empty transcript."
        )


class EmptySummaryInput(CaptureServiceError):
    """Neither a transcript nor any cards were sent to summarise.

    Either input alone is enough to write minutes from — a meeting whose
    transcript is gone but whose cards survived still summarises, and a
    transcript with no cards is the normal case for a provider that only does
    summarisation. Only the combination of both being empty is a client bug.
    """

    code = "empty_summary_input"
    status = 400

    def __init__(self) -> None:
        super().__init__(
            "The request body contained neither transcript chunks nor insight "
            "cards, so there is nothing to write minutes from."
        )


class TranscriberUnavailable(CaptureServiceError):
    """faster-whisper is not installed, or the model could not be loaded."""

    code = "transcriber_unavailable"
    status = 503


class TranscriptionFailed(CaptureServiceError):
    """Whisper was available but the transcription itself failed."""

    code = "transcription_failed"
    status = 500


class LlmTimeout(CaptureServiceError):
    """Ollama did not answer within CAPTURE_TIMEOUT_SECONDS."""

    code = "capture_upstream_timeout"
    status = 504


class LlmUnreachable(CaptureServiceError):
    """No TCP connection to Ollama: refused, DNS failure, wrong host."""

    code = "capture_upstream_unreachable"
    status = 502


class LlmEndpointUnavailable(CaptureServiceError):
    """Something answered, but it was not the Ollama API.

    The classic misconfiguration: CAPTURE_OLLAMA_BASE_URL points at a proxy,
    an SPA fallback or the wrong port, and a 200 text/html page comes back.
    """

    code = "capture_endpoint_unavailable"
    status = 502


class LlmModelNotFound(CaptureServiceError):
    """Ollama is reachable but the configured model has not been pulled."""

    code = "capture_model_not_found"
    status = 503


class LlmRequestFailed(CaptureServiceError):
    """Ollama answered with an error status, or with no usable message."""

    code = "capture_upstream_error"
    status = 502

    def __init__(self, message: str, upstream_status: int | None = None) -> None:
        super().__init__(message)
        self.upstream_status = upstream_status


class LlmOutputTruncated(CaptureServiceError):
    """The model ran out of output tokens before finishing the JSON."""

    code = "capture_output_truncated"
    status = 422


class CaptureExtractionError(CaptureServiceError):
    """Model output could not be parsed into InsightCard[].

    Port of CaptureExtractionError in
    lib/connectors/capture/parseInsightCards.ts: same `reason` enum, same
    optional `card_index`. Only `reason` (and `cardIndex`) cross the wire —
    both are numbers/enum values, never content.
    """

    code = "capture_parse_error"
    status = 422

    def __init__(
        self,
        reason: ParseFailureReason,
        message: str,
        card_index: int | None = None,
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.card_index = card_index

    def response_extras(self) -> dict[str, object]:
        extras: dict[str, object] = {"reason": self.reason}
        if self.card_index is not None:
            extras["cardIndex"] = self.card_index
        return extras
