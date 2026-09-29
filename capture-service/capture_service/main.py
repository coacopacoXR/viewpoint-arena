"""capture-service HTTP surface (T4.1).

    GET  /health      configuration + readiness summary, safe to poll
    POST /capture     a complete meeting recording → { "cards": [...] }
    POST /transcribe  a complete meeting recording → { "transcript": [...] }
    POST /extract     an existing transcript       → { "cards": [...] }
    POST /summarize   a transcript and/or cards    → { "summary": "<markdown>" }

No WebSocket and no streaming. The live transcript (T4.7, first slice) is
built from this same batch surface: while recording, the browser cuts a
standalone ~8 s clip and POSTs it to /transcribe (via the app's
/api/capture/transcribe proxy); cards still come from one /capture of the
whole recording at stop.

/extract and /summarize are the TEXT halves of the same pipeline, split out
because the app's server-side AI router (docs/plan/14-rooms-models-admin-ai.md)
picks a provider per JOB: a deployment may transcribe with this service and
extract with Anthropic, or extract here and summarise in the cloud. A route
that only accepts audio cannot be one provider among several, so each stage
gets an endpoint that takes the previous stage's output as JSON. /capture is
still the whole chain in one request, and it is what the browser calls.

Two design rules this file exists to keep:

  * THE SUCCESS BODY IS EXACTLY THE ENVELOPE, with no transport metadata mixed
    in. The browser client re-validates a capture response with
    `validateExtractionPayload`, which rejects unknown keys — so a helpful
    `{"cards": [...], "tookMs": 4200}` would be a broken response, not a nicer
    one. Debugging detail goes to /health and to the log.

  * NOTHING IN AN ERROR RESPONSE OR A LOG LINE CARRIES CONTENT. Errors return
    the `code` (and at most a reason enum, a card index or a byte limit); the
    detail an operator needs is in the message, which errors.py guarantees is
    transcript-free. The uploaded filename is never echoed either — it is
    client-controlled text. This applies with equal force to /extract and
    /summarize, which take a transcript in the REQUEST BODY rather than
    deriving one from audio.

Routes are plain `def`, not `async def`: Whisper transcription blocks a worker
for the length of the recording, and FastAPI runs sync routes in a threadpool so
one meeting cannot stall the event loop for everyone else.

When CAPTURE_SHARED_SECRET is set, every route below — /health and /docs
included — requires it. auth.py explains why there is no exemption list.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath
from typing import Annotated, AsyncIterator

from fastapi import APIRouter, FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from . import __version__
from .auth import AUTH_HEADER, AUTHORIZATION_HEADER, require_shared_secret
from .config import Settings, load_settings
from .errors import (
    CaptureServiceError,
    EmptySummaryInput,
    EmptyTranscript,
    EmptyTranscriptRequest,
    EmptyUpload,
    UploadTooLarge,
)
from .ollama import LlmClient, OllamaClient
from .parse_cards import parse_insight_cards
from .prompt import (
    EXTRACTION_SYSTEM_PROMPT,
    SUMMARY_SYSTEM_PROMPT,
    build_extraction_user_prompt,
    build_summary_user_prompt,
)
from .schemas import (
    DEFAULT_SLIDE_TITLE,
    CaptureResponse,
    ErrorBody,
    ExtractRequest,
    HealthResponse,
    InsightCard,
    LimitsHealth,
    LlmHealth,
    SlideContext,
    SummaryRequest,
    SummaryResponse,
    TranscribeResponse,
    TranscriptChunk,
    WhisperHealth,
)
from .transcribe import (
    MAX_TRANSCRIPT_CHARS,
    MAX_TRANSCRIPT_CHUNKS,
    FasterWhisperTranscriber,
    Transcriber,
    enforce_transcript_budget,
)

logger = logging.getLogger("capture_service")

SERVICE_NAME = "capture-service"

# Uploads are streamed to a temp file in 1 MiB reads. Streaming (rather than
# `await upload.read()`) is what makes CAPTURE_MAX_UPLOAD_BYTES enforceable: an
# oversized recording is abandoned the moment the counter passes the limit,
# instead of being buffered whole and rejected afterwards.
READ_CHUNK_BYTES = 1024 * 1024

# A client-supplied filename is untrusted. Only a short alphanumeric extension
# is ever appended to the temp file name, so no separator or ".." can survive
# into a filesystem path.
_SAFE_SUFFIX = re.compile(r"^\.[a-z0-9]{1,8}$")

_ERROR_MODEL = {"model": ErrorBody, "description": "See capture_service/errors.py."}
ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    400: _ERROR_MODEL,
    413: _ERROR_MODEL,
    422: _ERROR_MODEL,
    500: _ERROR_MODEL,
    502: _ERROR_MODEL,
    503: _ERROR_MODEL,
    504: _ERROR_MODEL,
}

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["capture"])
def health(request: Request) -> HealthResponse:
    """Configuration and readiness summary.

    Performs no I/O and never triggers a model load, so it is safe to poll from
    an install script or a container healthcheck: `loaded: false` means "no
    transcription has happened yet", not "broken".
    """
    settings: Settings = request.app.state.settings
    transcriber: Transcriber = request.app.state.transcriber

    return HealthResponse(
        status="ok",
        service=SERVICE_NAME,
        version=__version__,
        whisper=WhisperHealth(
            model=settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
            loaded=transcriber.is_loaded(),
        ),
        llm=LlmHealth(base_url=settings.ollama_base_url, model=settings.ollama_model),
        limits=LimitsHealth(
            max_upload_bytes=settings.max_upload_bytes,
            max_transcript_chars=MAX_TRANSCRIPT_CHARS,
            max_transcript_chunks=MAX_TRANSCRIPT_CHUNKS,
        ),
    )


@router.post(
    "/capture",
    response_model=CaptureResponse,
    response_model_exclude_none=True,
    responses=ERROR_RESPONSES,
    tags=["capture"],
)
def capture(
    request: Request,
    audio: Annotated[
        UploadFile,
        File(description="The complete meeting recording. Any format ffmpeg can decode."),
    ],
    agenda_idx: Annotated[int, Form(alias="agendaIdx", ge=0)] = 0,
    slide_title: Annotated[str, Form(alias="slideTitle")] = DEFAULT_SLIDE_TITLE,
    hovered_part_name: Annotated[str | None, Form(alias="hoveredPartName")] = None,
    laser_target_part_name: Annotated[
        str | None, Form(alias="laserTargetPartName")
    ] = None,
    component_tree: Annotated[
        str | None, Form(alias="componentTree")
    ] = None,
    pointing_segments_raw: Annotated[
        str | None, Form(alias="pointingSegments")
    ] = None,
    transcript_hint_raw: Annotated[
        str | None, Form(alias="transcriptHint")
    ] = None,
) -> CaptureResponse:
    """Transcribe a full meeting recording, then extract InsightCards from it.

    The four optional form fields are the SlideContext the speakers were in.
    Batch mode has ONE context for the whole recording — the agenda item the
    host was presenting, or the meeting title — because that is all the
    post-meeting MVP in docs/local-capture-plan.md has. Blank values fall back
    to the default title rather than labelling the prompt with an empty string.

    The three grounded-capture fields (componentTree, pointingSegments,
    transcriptHint) are JSON strings. Each is parsed defensively: bad JSON,
    wrong shape or oversized input is logged and ignored, never a 500.
    """
    settings: Settings = request.app.state.settings
    transcriber: Transcriber = request.app.state.transcriber
    llm: LlmClient = request.app.state.llm

    audio_path = _spool_upload(audio, settings.max_upload_bytes)
    try:
        transcript = transcriber.transcribe(audio_path)
    finally:
        # Deleted whether transcription succeeded or not: the recording is the
        # most sensitive artefact this service ever touches, and batch mode has
        # no use for it once the transcript exists.
        _remove_quietly(audio_path)

    if not transcript:
        raise EmptyTranscript()
    enforce_transcript_budget(transcript)

    context = _normalise_context(
        SlideContext(
            agenda_idx=agenda_idx,
            slide_title=slide_title,
            hovered_part_name=hovered_part_name,
            laser_target_part_name=laser_target_part_name,
        )
    )

    # Grounded-capture inputs: parsed defensively so a bad payload degrades to
    # the pre-section-D behaviour (no component list, no pointing, no hint)
    # rather than failing the request.
    components = _parse_component_tree(component_tree)
    pointing_segments = _parse_pointing_segments(pointing_segments_raw)
    transcript_hint = _parse_transcript_hint(transcript_hint_raw)
    _log_grounded_counts("capture", components, pointing_segments, transcript_hint)

    cards = _extract_cards(
        llm,
        transcript,
        context,
        components=components,
        pointing_segments=pointing_segments,
        transcript_hint=transcript_hint,
    )
    logger.info(
        "capture: %d chunk(s) transcribed, %d card(s) extracted",
        len(transcript),
        len(cards),
    )
    return CaptureResponse(cards=cards)


@router.post(
    "/transcribe",
    response_model=TranscribeResponse,
    response_model_exclude_none=True,
    responses=ERROR_RESPONSES,
    tags=["capture"],
)
def transcribe(
    request: Request,
    audio: Annotated[
        UploadFile,
        File(description="The complete meeting recording. Any format ffmpeg can decode."),
    ],
) -> TranscribeResponse:
    """Transcribe only — no LLM call.

    Exists so a contributor can prove the Whisper half of the stack works
    without Ollama installed and running, and so an operator can inspect what
    the model was actually asked about. The transcript is returned to the same
    client that uploaded the audio, so this reveals nothing new; it is NOT
    logged.
    """
    settings: Settings = request.app.state.settings
    transcriber: Transcriber = request.app.state.transcriber

    audio_path = _spool_upload(audio, settings.max_upload_bytes)
    try:
        transcript = transcriber.transcribe(audio_path)
    finally:
        _remove_quietly(audio_path)

    logger.info("transcribe: %d chunk(s)", len(transcript))
    return TranscribeResponse(transcript=transcript)


@router.post(
    "/extract",
    response_model=CaptureResponse,
    response_model_exclude_none=True,
    responses=ERROR_RESPONSES,
    tags=["capture"],
)
def extract(request: Request, body: ExtractRequest) -> CaptureResponse:
    """Extract InsightCards from a transcript this service did not produce.

    The LLM half of /capture, addressable on its own: no audio, no Whisper, no
    temp file. The AI router (docs/plan/14-rooms-models-admin-ai.md) calls this
    when transcription came from somewhere else — a cloud provider, or a
    /transcribe call made minutes earlier — and still wants this service's
    extraction, which is the one whose prompt and parser the app already
    validates against.

    Everything downstream of the transcript is shared with /capture: same
    SlideContext normalisation, same defensive handling of the three grounded
    fields, same prompt, same parser, same `{"cards": [...]}` envelope. A card
    this route returns is indistinguishable from one /capture returned, which
    is the point of splitting the pipeline rather than writing a second one.
    """
    llm: LlmClient = request.app.state.llm
    transcript = body.transcript

    # Not EmptyTranscript: that one means Whisper ran and the recording had no
    # speech in it, and it says so. Here the client sent the empty array
    # itself, which is a 400 with a different fix.
    if not transcript:
        raise EmptyTranscriptRequest()
    # The same budget /capture enforces on what Whisper produced. A caller that
    # transcribed elsewhere can hand this route a meeting of any length, and
    # the ceiling exists to keep one request inside the model's context window
    # rather than to police a file size.
    enforce_transcript_budget(transcript)

    context = _normalise_context(body.context)

    # Already parsed by pydantic, so only the shape filter applies — the same
    # one /capture runs after json.loads. A malformed value degrades to "not
    # sent" rather than failing an extraction that would otherwise work.
    components = _filter_component_tree(body.component_tree)
    pointing_segments = _filter_pointing_segments(body.pointing_segments)
    transcript_hint = _filter_transcript_hint(body.transcript_hint)
    _log_grounded_counts("extract", components, pointing_segments, transcript_hint)

    cards = _extract_cards(
        llm,
        transcript,
        context,
        components=components,
        pointing_segments=pointing_segments,
        transcript_hint=transcript_hint,
    )
    logger.info(
        "extract: %d chunk(s) in, %d card(s) extracted", len(transcript), len(cards)
    )
    return CaptureResponse(cards=cards)


@router.post(
    "/summarize",
    response_model=SummaryResponse,
    responses=ERROR_RESPONSES,
    tags=["capture"],
)
def summarize(request: Request, body: SummaryRequest) -> SummaryResponse:
    """Write a meeting's minutes as markdown.

    The third AI job the router can place here. Unlike every other route this
    service has, the answer is prose a person reads, not structured data: the
    reply is returned verbatim in `{"summary": "..."}` and nothing parses it.
    That is why the LLM call passes `schema=None` — Ollama's structured-output
    mode would otherwise be asked for InsightCard JSON while the prompt asks
    for markdown, and the model would answer one of the two.

    Either input alone is enough. Cards-only is what a caller has when the
    transcript was not kept; transcript-only is what a caller has when the
    extraction was routed to a different provider. Both empty is the only
    refusal, and it is a client bug.
    """
    llm: LlmClient = request.app.state.llm

    if not body.transcript and not body.cards:
        raise EmptySummaryInput()
    # The budget is about the model's context window, not about audio, so a
    # transcript that arrived as JSON is measured just like one Whisper made.
    enforce_transcript_budget(body.transcript)

    summary = llm.complete(
        SUMMARY_SYSTEM_PROMPT,
        build_summary_user_prompt(body.transcript, body.cards, body.title),
        schema=None,
    )
    # Counts and a length, never content: the summary quotes the meeting, and
    # this service's rule is that neither a response's failure path nor the log
    # carries what was said. The length is what an operator needs to tell a
    # truncated answer from a model that had nothing to say.
    logger.info(
        "summarize: %d chunk(s), %d card(s) in, %d character(s) of minutes",
        len(body.transcript),
        len(body.cards),
        len(summary),
    )
    return SummaryResponse(summary=summary)


# ─── Grounded-capture input parsing ─────────────────────────────────────────
#
# The three grounded fields are advisory context, and the rule for them is that
# a bad value DEGRADES rather than fails: bad JSON, wrong shape or an oversized
# array becomes None (logged), and the extraction proceeds as if the field was
# not sent. A malformed hint must never turn a good meeting into a 500, and it
# must not turn it into a 400 either — the caller cannot fix what it did not
# mean to send, and the insight in the transcript is still worth having.
#
# /capture receives them as JSON strings in a multipart form; /extract receives
# them already parsed in a JSON body. Both end up in the same _filter_*
# function, so the shape rules and the caps exist once.

_MAX_COMPONENTS = 200
_MAX_POINTING_SEGMENTS = 500
_MAX_TRANSCRIPT_HINT_LINES = 400


def _decode_json_array(raw: str | None, field: str) -> list[object] | None:
    """json.loads a form field that is supposed to hold an array.

    The multipart half of the defensive rule: a string that is not JSON, or is
    JSON but not an array, is logged and dropped. /extract skips this step
    because pydantic already handed it a parsed value.
    """
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        logger.warning("capture-service: %s was not valid JSON; ignoring", field)
        return None
    if not isinstance(parsed, list):
        logger.warning("capture-service: %s was not an array; ignoring", field)
        return None
    return parsed


def _filter_component_tree(value: object) -> list[dict[str, str]] | None:
    """Keep the well-formed entries of a componentTree array, up to the cap.

    Expected shape: [{ "id": str, "name": str, "path": str }, ...].
    Returns None for anything unusable, so the caller proceeds without a
    component list — which also means without componentReference filtering,
    the pre-section-D behaviour.
    """
    if not isinstance(value, list):
        return None
    result: list[dict[str, str]] = []
    for entry in value[:_MAX_COMPONENTS]:
        if not isinstance(entry, dict):
            continue
        cid = entry.get("id")
        cname = entry.get("name")
        cpath = entry.get("path")
        if isinstance(cid, str) and isinstance(cname, str) and isinstance(cpath, str):
            result.append({"id": cid, "name": cname, "path": cpath})
    return result or None


def _parse_component_tree(raw: str | None) -> list[dict[str, str]] | None:
    """The componentTree FORM field: decode the JSON string, then filter it."""
    return _filter_component_tree(_decode_json_array(raw, "componentTree"))


def _filter_pointing_segments(value: object) -> list[dict[str, object]] | None:
    """Keep the well-formed entries of a pointingSegments array, up to the cap.

    Expected shape: [{ "userId", "userName", "partId", "partName", "fromMs", "toMs" }, ...].
    """
    if not isinstance(value, list):
        return None
    result: list[dict[str, object]] = []
    for entry in value[:_MAX_POINTING_SEGMENTS]:
        if not isinstance(entry, dict):
            continue
        if (
            isinstance(entry.get("userId"), str)
            and isinstance(entry.get("userName"), str)
            and isinstance(entry.get("partId"), str)
            and isinstance(entry.get("partName"), str)
            and isinstance(entry.get("fromMs"), (int, float))
            and isinstance(entry.get("toMs"), (int, float))
        ):
            result.append(entry)
    return result or None


def _parse_pointing_segments(raw: str | None) -> list[dict[str, object]] | None:
    """The pointingSegments FORM field: decode the JSON string, then filter it."""
    return _filter_pointing_segments(_decode_json_array(raw, "pointingSegments"))


def _filter_transcript_hint(value: object) -> list[dict[str, object]] | None:
    """Keep the well-formed entries of a transcriptHint array, up to the cap.

    Expected shape: [{ "speaker": str, "text": str, "offsetMs": number }, ...].
    The transcript hint is extra context for attribution, NOT a replacement for
    the transcript being extracted from. A client could lie about it, so nothing
    security-relevant may depend on it.
    """
    if not isinstance(value, list):
        return None
    result: list[dict[str, object]] = []
    for entry in value[:_MAX_TRANSCRIPT_HINT_LINES]:
        if not isinstance(entry, dict):
            continue
        if (
            isinstance(entry.get("speaker"), str)
            and isinstance(entry.get("text"), str)
            and isinstance(entry.get("offsetMs"), (int, float))
        ):
            result.append(entry)
    return result or None


def _parse_transcript_hint(raw: str | None) -> list[dict[str, object]] | None:
    """The transcriptHint FORM field: decode the JSON string, then filter it."""
    return _filter_transcript_hint(_decode_json_array(raw, "transcriptHint"))


def _log_grounded_counts(
    job: str,
    components: list[dict[str, str]] | None,
    pointing_segments: list[dict[str, object]] | None,
    transcript_hint: list[dict[str, object]] | None,
) -> None:
    """Counts only — never content.

    Without this there is no way to tell a grounded request from an ungrounded
    one after the fact, and the difference decides whether a card's
    componentReference can be trusted: an ungrounded extraction had no
    component list to filter against, so that field is whatever the model said.
    """
    logger.info(
        "%s: grounded with %d component(s), %d pointing segment(s), %d hint line(s)",
        job,
        len(components or []),
        len(pointing_segments or []),
        len(transcript_hint or []),
    )


# ─── The extraction call, shared by /capture and /extract ───────────────────


def _normalise_context(context: SlideContext | None) -> SlideContext:
    """Apply the blank-value rules to a client-supplied SlideContext.

    A blank title becomes DEFAULT_SLIDE_TITLE and a blank part name becomes
    absent, so the prompt never says "Agenda item 0: " or "A speaker was
    hovering over: ". One rule for both routes: /capture's multipart form and
    /extract's JSON body carry the same context and must render identically,
    or the same meeting summarises differently depending on which one the
    router chose.
    """
    if context is None:
        return SlideContext()
    return SlideContext(
        agenda_idx=context.agenda_idx,
        slide_title=(context.slide_title or "").strip() or DEFAULT_SLIDE_TITLE,
        hovered_part_name=_blank_to_none(context.hovered_part_name),
        laser_target_part_name=_blank_to_none(context.laser_target_part_name),
    )


def _extract_cards(
    llm: LlmClient,
    transcript: list[TranscriptChunk],
    context: SlideContext,
    *,
    components: list[dict[str, str]] | None,
    pointing_segments: list[dict[str, object]] | None,
    transcript_hint: list[dict[str, object]] | None,
) -> list[InsightCard]:
    """One constrained LLM pass over an existing transcript, then the parser.

    The whole reason /extract can promise the same cards /capture produces:
    both call this. `transcript` must be non-empty — both callers check first,
    and the default-agent rule below reads element 0.

    @raises CaptureServiceError from the client (upstream problems) or from
            parse_insight_cards (unusable model output). Never anything else.
    """
    component_ids = {c["id"] for c in components} if components else None

    raw_reply = llm.complete(
        EXTRACTION_SYSTEM_PROMPT,
        build_extraction_user_prompt(
            transcript,
            context,
            components=components,
            pointing_segments=pointing_segments,
            transcript_hint=transcript_hint,
        ),
    )

    # Same default-agent rule as the TypeScript providers: a card that does not
    # name a speaker is attributed to the first one in the window.
    return parse_insight_cards(
        raw_reply,
        default_agent_id=transcript[0].speaker_id or None,
        component_ids=component_ids,
    )


# ─── Upload handling ────────────────────────────────────────────────────────


def _spool_upload(upload: UploadFile, max_bytes: int) -> Path:
    """Stream an upload to a temp file, refusing to exceed `max_bytes`.

    Returns the path; the CALLER owns deletion.

    The declared size (Content-Length, which Starlette tracks while parsing the
    multipart body) is checked first so an obviously oversized upload is
    rejected before it is copied anywhere. The streaming counter is the real
    guarantee, because a chunked request has no declared size.
    """
    declared = getattr(upload, "size", None)
    if isinstance(declared, int) and declared > max_bytes:
        raise UploadTooLarge(max_bytes)

    file_descriptor, raw_path = tempfile.mkstemp(
        prefix="capture-upload-", suffix=_safe_suffix(upload.filename)
    )
    path = Path(raw_path)
    total = 0
    try:
        with os.fdopen(file_descriptor, "wb") as destination:
            # Ownership of the descriptor has passed to the file object; -1
            # tells the finally block not to close it a second time (a reused
            # descriptor number would close somebody else's file).
            file_descriptor = -1
            while True:
                chunk = upload.file.read(READ_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise UploadTooLarge(max_bytes)
                destination.write(chunk)
    except BaseException:
        _remove_quietly(path)
        raise
    finally:
        # Only reached with a live descriptor if os.fdopen itself failed.
        if file_descriptor != -1:
            _close_quietly(file_descriptor)

    if total == 0:
        _remove_quietly(path)
        raise EmptyUpload()

    return path


def _safe_suffix(filename: str | None) -> str:
    if not filename:
        return ""
    suffix = PurePosixPath(str(filename).replace("\\", "/")).suffix.lower()
    return suffix if _SAFE_SUFFIX.match(suffix) else ""


def _blank_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def _remove_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        # A temp file this service cannot delete is worth a log line and
        # nothing more: failing the request over it would hide the real result.
        logger.warning("capture-service: could not remove a temp upload file")


def _close_quietly(file_descriptor: int) -> None:
    try:
        os.close(file_descriptor)
    except OSError:
        pass


# ─── App factory ────────────────────────────────────────────────────────────


def create_app(
    settings: Settings | None = None,
    transcriber: Transcriber | None = None,
    llm: LlmClient | None = None,
) -> FastAPI:
    """Build the FastAPI app.

    Every collaborator is injectable, which is the whole reason the test suite
    needs no GPU, no downloaded Whisper model, no Ollama and no network:
    tests/conftest.py passes a fake transcriber and a fake LLM client. In
    production the defaults are constructed here — and note that neither
    default touches its backend at construction time. The Whisper model loads
    on the first /capture request; the Ollama client opens no socket until it
    is called.
    """
    resolved_settings = settings if settings is not None else load_settings()
    resolved_transcriber = (
        transcriber
        if transcriber is not None
        else FasterWhisperTranscriber(resolved_settings)
    )
    resolved_llm = (
        llm
        if llm is not None
        else OllamaClient(
            resolved_settings.ollama_base_url,
            resolved_settings.ollama_model,
            resolved_settings.timeout_seconds,
        )
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        close = getattr(app.state.llm, "close", None)
        if callable(close):
            close()

    app = FastAPI(
        title="Viewpoint Arena capture-service",
        version=__version__,
        summary=(
            "Local, batch-mode meeting capture: a full recording goes in, "
            "InsightCards come out. Nothing leaves the network it runs on."
        ),
        lifespan=lifespan,
    )
    app.state.settings = resolved_settings
    app.state.transcriber = resolved_transcriber
    app.state.llm = resolved_llm

    _register_error_handlers(app)

    # Registered ONLY when a secret is configured, so an unauthenticated laptop
    # run has the exact request path it always had: no middleware, no per-request
    # header lookup, nothing to disable. See auth.py for why this is opt-in by
    # absence and why it covers every route including /health and /docs.
    if resolved_settings.shared_secret is not None:
        app.middleware("http")(
            require_shared_secret(resolved_settings.shared_secret)
        )

    # CORS is opt-in by absence, exactly like authentication: unset or empty
    # CAPTURE_ALLOWED_ORIGINS adds no middleware, so the service keeps sending
    # no Access-Control-Allow-Origin and browsers block cross-origin calls.
    # Set the variable and the service allows exactly those origins — never *
    # (config._allowed_origins refuses it).
    #
    # Registered AFTER the auth middleware on purpose. Starlette wraps each new
    # middleware around the ones before it, so the last one added runs first.
    # CORS has to be outermost: a browser preflight (OPTIONS) never carries the
    # token, and would otherwise get auth's 401 and fail; and a real 401 needs
    # the CORS headers for the browser to let the page read it.
    if resolved_settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=resolved_settings.allowed_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Content-Type", AUTH_HEADER, AUTHORIZATION_HEADER],
        )

    app.include_router(router)
    return app


def _register_error_handlers(app: FastAPI) -> None:
    """Turn every failure into a code-only JSON body.

    These handlers are the enforcement point for "no content in an error": the
    message never crosses the wire, whatever raised it.
    """

    @app.exception_handler(CaptureServiceError)
    def _capture_service_error(
        request: Request, exc: CaptureServiceError
    ) -> JSONResponse:
        # The message is transcript-free by construction (see errors.py), so it
        # is the safe place for operator detail — and the log is the only place
        # it goes.
        logger.warning("capture-service %s: %s", exc.code, exc.message)
        return JSONResponse(status_code=exc.status, content=exc.response_body())

    @app.exception_handler(RequestValidationError)
    def _invalid_request(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # exc.errors() carries `input` — the client's own value, which for this
        # endpoint can be transcript-adjacent. Only field LOCATIONS are read.
        fields = sorted(
            {
                ".".join(str(part) for part in error.get("loc", ())[1:]) or "request"
                for error in exc.errors()
            }
        )
        logger.warning("capture-service invalid_request: %s", ", ".join(fields))
        return JSONResponse(
            status_code=400, content={"error": "invalid_request", "fields": fields}
        )

    @app.exception_handler(StarletteHTTPException)
    def _http_exception(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(
            exc.status_code, f"http_{exc.status_code}"
        )
        # exc.detail is dropped: for a framework-raised error it is boilerplate,
        # and this service would rather have one predictable error shape.
        return JSONResponse(
            status_code=exc.status_code, content={"error": code}, headers=exc.headers
        )

    @app.exception_handler(Exception)
    def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        # The traceback goes to the log; the client gets a code. Without this
        # handler an unhandled exception becomes Starlette's bare 500, and the
        # next person to add a raise has to remember what may be quoted in it.
        logger.exception("capture-service unhandled %s", type(exc).__name__)
        return JSONResponse(status_code=500, content={"error": "internal_error"})


def load_module_app() -> FastAPI:
    """Build the module-level app, turning a config error into a clean exit.

    Split out from the assignment below so tests can exercise the failure path
    without re-importing this module (a reload that raises would leave it half
    initialised for everything else in the suite).
    """
    try:
        return create_app()
    except CaptureServiceError as exc:
        # One line naming the variable, instead of a traceback: this runs while
        # uvicorn is importing the module, and the operator needs to know which
        # line of the generated .env to fix.
        raise SystemExit(
            f"{SERVICE_NAME}: configuration error — {exc.message}"
        ) from None


# Importable as `uvicorn capture_service.main:app`.
app = load_module_app()
