# capture-service

Local, **batch-mode** meeting capture for Viewpoint Arena: a complete meeting
recording goes in, structured `InsightCard[]` comes out. Nothing — no audio, no
transcript, no model output — leaves the network this service runs on.

Implements **T4.1–T4.3** of [`docs/plan/08-task-breakdown.md`](../docs/plan/08-task-breakdown.md)
and the "Strong suggestion for the first iteration" MVP in
[`docs/local-capture-plan.md`](../docs/local-capture-plan.md):

> 1. Skip live transcripts. Browser records the whole meeting locally, uploads
>    the audio file at meeting-end. 2. capture-service runs whisper on it
>    (batch, not streaming) … 3. LLM does one pass extraction on the full
>    transcript …

```
recording.webm ──▶ POST /capture ──▶ faster-whisper (batch) ──▶ TranscriptChunk[]
                                                                        │
                     { "cards": InsightCard[] } ◀── defensive parser ◀── Ollama (one pass)
```

`/capture` is the whole chain in one request. Each stage is also addressable on
its own — `/transcribe` (audio → transcript), `/extract` (transcript → cards)
and `/summarize` (transcript and/or cards → markdown minutes) — so the app's
server-side AI router can place one job here and another with a different
provider.

There is **no streaming, no WebSocket and no live partial transcript** here.
That is T4.7, deliberately sequenced after the offline path is solid.

---

## 1. Run it locally, without Docker

Requires **Python 3.11+** (`StrEnum`, `X | None`). Nothing else: `faster-whisper`
decodes audio through PyAV, which bundles the ffmpeg libraries, so there is no
system ffmpeg to install.

```bash
cd capture-service

# 1. A virtualenv
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

# 2. The HTTP service
pip install -r requirements.txt

# 3. Real transcription (skip this and the service still starts; POST /capture
#    then answers 503 transcriber_unavailable with the install hint)
pip install -r requirements-whisper.txt

# 4. Start it
python -m capture_service
# …or, equivalently, with flags instead of environment variables:
uvicorn capture_service.main:app --host 127.0.0.1 --port 8080
```

Then check it:

```bash
curl http://127.0.0.1:8080/health
```

Interactive API docs are served at <http://127.0.0.1:8080/docs>.

The default bind address is **127.0.0.1**, so a laptop run is not published to
the office network. A container sets `CAPTURE_HOST=0.0.0.0` explicitly.

---

## 2. Configuration

Everything is an environment variable. There is no settings file and no
settings UI: the install script in `docs/local-capture-plan.md` generates a
`.env`, docker-compose passes it to the container, a systemd unit reads it — one
mechanism, three deployments. The service reads `os.environ` directly; it does
**not** auto-load a `.env` file. Either export the values, or let uvicorn do it:

```bash
cp .env.example .env    # then edit
uvicorn capture_service.main:app --env-file .env --host 127.0.0.1 --port 8080
```

Every variable is optional; the defaults are the documented local-install
values. An invalid value fails at start-up with the variable named, rather than
three requests into a meeting.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAPTURE_WHISPER_MODEL` | `base.en` | faster-whisper model size (`tiny`, `base`, `small`, `medium`, `large-v3`, `.en` variants) **or** a path to a local CTranslate2 model directory for air-gapped installs. |
| `CAPTURE_WHISPER_DEVICE` | `cpu` | `auto`, `cpu` or `cuda`. |
| `CAPTURE_WHISPER_COMPUTE_TYPE` | `int8` | `default`, `auto`, `int8`, `int8_float16`, `float16`, `float32`. Use `float16` on a GPU. |
| `CAPTURE_WHISPER_LANGUAGE` | *(empty)* | Language hint, e.g. `en` or `de`. Empty means auto-detect, which is slower and occasionally wrong on a mixed-language review. |
| `CAPTURE_OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | The Ollama **root** URL. Must have a scheme and host and **no path** — the service appends `/api/chat` itself. Must be reachable *from this service*, and must not contain a username or password. |
| `CAPTURE_OLLAMA_MODEL` | `qwen2.5:7b` | A model that is already pulled on that Ollama instance (`ollama list`). Chosen over the plan's `deepseek-r1:7b` by a head-to-head on a real recording: qwen found all three insights with assignee and the correct due date in 3 of 3 runs in ~20 s; deepseek-r1 missed the assignee and due date every time, titled cards just "RISK"/"ACTION" in 2 of 3, and took ~44 s. |
| `CAPTURE_TIMEOUT_SECONDS` | `600` | Per-request Ollama timeout. qwen2.5:7b took ~20 s per extraction fully on a GPU, and over 120 s when a 6 GB laptop GPU could hold only part of it; CPU-only is slower still. Keep it under the 900 s nginx timeout. |
| `CAPTURE_MAX_UPLOAD_BYTES` | `209715200` (200 MiB) | Hard ceiling on one uploaded recording — about four hours of Opus/WebM, under two hours of 16-bit mono WAV. Enforced while streaming the body, so an oversized upload costs no inference. |
| `CAPTURE_HOST` | `127.0.0.1` | Bind address for `python -m capture_service`. |
| `CAPTURE_PORT` | `8080` | Bind port for `python -m capture_service`. |
| `CAPTURE_ALLOWED_ORIGINS` | *(empty)* | Comma-separated list of exact browser origins allowed via CORS (e.g. `https://review.example.com,https://localhost`). Empty (the default) adds **no CORS middleware** — today's behaviour, unchanged. A wildcard `*` is refused: the service logs an error and starts without CORS rather than allowing every origin alongside the shared-secret header. Origins with a path or trailing slash are skipped. |

Hardware sizing (from `docs/local-capture-plan.md` §"Ollama"): 7B models want
8 GB+ RAM and are CPU-viable but slow; 13–14B want 16 GB+ and a GPU; a 32B
distill wants 24 GB+ VRAM.

None of these variables is a secret, and none of them may ever be given a
`VITE_` prefix: `VITE_` names are inlined into the browser bundle at build time,
which is the footgun [`scripts/check-public-env.mjs`](../scripts/check-public-env.mjs)
exists to catch.

---

## 3. HTTP interface

### `GET /health`

Configuration and readiness summary, safe to poll from an install script or a
container healthcheck. Performs no I/O and never triggers a model load, so
`loaded: false` means "no transcription has happened yet", not "broken".

```json
{
  "status": "ok",
  "service": "capture-service",
  "version": "0.1.0",
  "whisper": { "model": "base.en", "device": "cpu", "computeType": "int8", "loaded": false },
  "llm": { "baseUrl": "http://127.0.0.1:11434", "model": "qwen2.5:7b" },
  "limits": { "maxUploadBytes": 209715200, "maxTranscriptChars": 200000, "maxTranscriptChunks": 2000 }
}
```

### `POST /capture`

The whole pipeline. `multipart/form-data`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `audio` | file | yes | The complete meeting recording. Any format ffmpeg/PyAV can decode (`webm`, `wav`, `mp3`, `mp4`, …). |
| `agendaIdx` | int ≥ 0 | no (default `0`) | Which agenda item was being presented. |
| `slideTitle` | string | no (default `Full meeting recording`) | Its title. A blank value falls back to the default. |
| `hoveredPartName` | string | no | Component a speaker was hovering over. |
| `laserTargetPartName` | string | no | Component the laser pointer was on. |

The four optional fields are the `SlideContext` from
[`lib/connectors/capture/types.ts`](../lib/connectors/capture/types.ts). Batch
mode has **one** context for the whole recording — that is all the
post-meeting MVP has, and per-chunk spatial context arrives with the streaming
work in T4.7.

```bash
curl -sS http://127.0.0.1:8080/capture \
  -F "audio=@./review-recording.webm" \
  -F "agendaIdx=3" \
  -F "slideTitle=Rear triangle weld" \
  -F "hoveredPartName=Bracket"
```

`200` — the body is **exactly** the envelope, with no transport metadata:

```json
{
  "cards": [
    {
      "id": "insight-6f1c1c4e-2b7a-4d3e-9a51-2c8f0b6d4e11",
      "type": "RISK",
      "agentId": "speaker-1",
      "title": "Bracket weld cracks under load",
      "description": "The reviewer said the weld will crack before the yield target.",
      "timestamp": 1788859683832,
      "details": { "priority": "High", "status": "Open", "impact": "Warranty returns" }
    }
  ]
}
```

That shape is not a style choice. The browser client re-validates a capture
response with `validateExtractionPayload` from
[`lib/connectors/capture/parseInsightCards.ts`](../lib/connectors/capture/parseInsightCards.ts),
which **rejects unknown keys** — so a helpful `{"cards": […], "tookMs": 4200}`
would be a broken response, not a nicer one. Debugging detail goes to `/health`
and to the log. Cards are the same `InsightCard` shape as
[`types.ts`](../types.ts), with `id` and `timestamp` minted here (the model is
asked not to emit them) and optional keys omitted entirely rather than sent as
`null`.

`{"cards": []}` is a successful response: the prompt tells the model to return
zero cards when the meeting contained nothing worth capturing.

### `POST /transcribe`

Whisper only, no LLM call. Same `audio` field, no context fields.

```json
{ "transcript": [ { "speakerId": "speaker-1", "text": "The weld will crack.", "startMs": 0, "endMs": 4200 } ] }
```

It exists so a contributor can prove the Whisper half of the stack works without
Ollama installed, and so an operator can see what the model was actually asked
about. The transcript is returned to the same client that uploaded the audio, so
it reveals nothing new — and it is never logged.

### `POST /extract`

The LLM half of `/capture`, on its own: `application/json`, no audio and no
Whisper. `200` returns **exactly** the `{"cards": […]}` envelope `/capture`
returns, and every failure carries the same codes, so a caller cannot tell which
route produced a card.

```json
{
  "transcript": [
    { "speakerId": "speaker-1", "text": "The weld will crack.", "startMs": 0, "endMs": 4200 }
  ],
  "context": { "agendaIdx": 3, "slideTitle": "Rear triangle weld", "hoveredPartName": "Bracket" },
  "componentTree": [{ "id": "left_cup", "name": "Left Cup", "path": "HP / Left Cup" }],
  "pointingSegments": [],
  "transcriptHint": []
}
```

Only `transcript` is required (and it may not be empty). `context` is the same
`SlideContext` `/capture` takes as form fields; the last three are the grounded
fields, sent **already parsed** rather than as JSON strings, and subject to the
same caps and the same rule that a malformed one is ignored rather than refused.

### `POST /summarize`

The meeting's minutes, as markdown. Either input alone is enough — cards-only is
what a caller has when the transcript was not kept, transcript-only is what a
caller has when extraction went to a different provider — but both empty is a
`400 empty_summary_input`.

```json
{ "transcript": [ … ], "cards": [ … ], "title": "Rear triangle weld" }
```

```json
{ "summary": "## What was reviewed\n…" }
```

`summary` is returned verbatim and is **not** parsed or validated: the answer is
prose a person reads. That is why this call is the one place the service asks the
model for free text instead of constraining it to the card schema. The prompt is
a copy of [`lib/ai/summaryPrompt.ts`](../lib/ai/summaryPrompt.ts).

Both routes exist because the app's server-side AI router picks a provider per
**job**: transcription, extraction and summarisation can each be placed with a
different provider, and a route that only accepts a recording cannot be one
provider among several. See
[`docs/plan/14-rooms-models-admin-ai.md`](../docs/plan/14-rooms-models-admin-ai.md).

### Errors

Every non-2xx body is `{"error": "<code>"}` plus at most a `reason` enum, a
`cardIndex`, a `maxUploadBytes` number or a list of `fields`. **Never** the
transcript, the model's output, a credential or a filesystem path — the detail
an operator needs goes to the server log, and
[`capture_service/errors.py`](capture_service/errors.py) documents why every
message is transcript-free by construction.

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | A form field or a JSON body failed validation. `fields` names the offending paths (`transcript.0.startMs`, `cards.0.details.priority`); values are not echoed. |
| 400 | `empty_upload` | The upload was 0 bytes. |
| 400 | `empty_transcript` | `/extract` was sent no transcript chunks. Same code as the 422 below, different status: nothing ran, the caller sent nothing. |
| 400 | `empty_summary_input` | `/summarize` was sent neither a transcript nor any cards. |
| 400 | `not_found` / `method_not_allowed` | Wrong path or verb. |
| 413 | `upload_too_large` | Over `CAPTURE_MAX_UPLOAD_BYTES`. Rejected while streaming, before any inference. |
| 413 | `transcript_too_large` | The transcript exceeds the prompt budget (same limits as `api/capture/extract.ts`). Enforced on `/capture`, `/extract` and `/summarize` alike: the ceiling is about the model's context window, not about audio. |
| 422 | `empty_transcript` | Whisper ran and found no speech. |
| 422 | `capture_output_truncated` | The model hit its output-token limit before finishing the JSON. |
| 422 | `capture_parse_error` | The model's reply was not usable InsightCard JSON. `reason` is one of `markdown_fenced`, `prose`, `truncated_json`, `malformed_json`, `wrong_envelope`, `extra_fields`, `invalid_card` — the same enum the TypeScript parser produces. |
| 500 | `transcription_failed` | Whisper was available but decoding/transcription failed. |
| 500 | `internal_error` | A bug. The traceback is in the log; the response says nothing else. |
| 502 | `capture_upstream_unreachable` | No connection to Ollama (refused, DNS, wrong host). |
| 502 | `capture_endpoint_unavailable` | Something answered, but it was not the Ollama API (a proxy, an SPA fallback, the wrong port). |
| 502 | `capture_upstream_error` | Ollama returned an error status, or a reply with no usable message. |
| 503 | `transcriber_unavailable` | faster-whisper is not installed, or the model could not be loaded. |
| 503 | `capture_model_not_found` | Ollama is reachable but `CAPTURE_OLLAMA_MODEL` has not been pulled. |
| 504 | `capture_upstream_timeout` | Ollama did not answer within `CAPTURE_TIMEOUT_SECONDS`. |

The codes shared with the cloud path (`capture_parse_error`,
`capture_output_truncated`, `capture_upstream_error`,
`capture_upstream_unreachable`, `empty_transcript`, `transcript_too_large`) are
the same strings `api/capture/extract.ts` returns, so
`lib/connectors/capture/extractClient.ts` already has a `case` for each. The
service-only codes fall through to that client's generic branch and print the
code. `tests/test_typescript_parity.py` pins this.

---

## 4. The real end-to-end path, on your own machine

CI cannot run this: it needs a model download and a running Ollama. Here is the
whole path, start to finish.

```bash
# 1. Ollama, if you do not have it: https://ollama.com/download
ollama serve &                 # already running if you installed the app
ollama pull qwen2.5:7b         # ~4.7 GB; the default extraction model
ollama list                    # confirm it is there

# 2. The service, with the transcription extra
cd capture-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-whisper.txt

# 3. Point it at Ollama (the defaults already do, if Ollama is local)
export CAPTURE_OLLAMA_BASE_URL="http://127.0.0.1:11434"
export CAPTURE_OLLAMA_MODEL="qwen2.5:7b"
export CAPTURE_WHISPER_MODEL="base.en"     # small.en if you want better accuracy

# 4. Start it — the first /capture request downloads the Whisper model
#    (~150 MB for base.en) into ~/.cache/huggingface and loads it into RAM.
python -m capture_service

# 5. Prove Whisper alone first: no Ollama involved, fast to diagnose
curl -sS http://127.0.0.1:8080/transcribe -F "audio=@./meeting.webm" | jq

# 6. Then the full pipeline
curl -sS http://127.0.0.1:8080/capture \
  -F "audio=@./meeting.webm" \
  -F "agendaIdx=1" -F "slideTitle=Frame weld review" | jq

# 7. Confirm what it is running with
curl -sS http://127.0.0.1:8080/health | jq
```

Expect the first `/capture` to take a while: model download, then transcription
(roughly real-time on CPU with `base.en`), then 5–10s of extraction for a 7B
model on CPU. Subsequent requests skip the download and the model stays loaded.

**Recording something to test with.** Any audio file works. To record from a
microphone on the command line, `ffmpeg -f avfoundation -i ":0" out.wav` (macOS)
or `ffmpeg -f alsa -i default out.wav` (Linux). Or take any existing meeting
recording — the service does not care what the audio is, only that PyAV can
decode it.

**When it fails, read the code first.** `capture_model_not_found` means
`ollama pull`. `capture_upstream_unreachable` means Ollama is not listening on
the address you gave (it binds 127.0.0.1 by default — set `OLLAMA_HOST=0.0.0.0`
on the Ollama host to reach it from another machine or a container).
`capture_endpoint_unavailable` means something that is not Ollama answered.
`transcriber_unavailable` means the whisper extra is missing or the model could
not be loaded (network access to huggingface.co, disk space, or a `cuda` device
that is not there). The service log carries the detail for each.

**Verifying against the app.** Once T4.4 lands
(`lib/connectors/capture/local.ts`), the browser posts the recorded meeting here
at session end and renders the reply as a "post-meeting summary" in the Manager
workspace. Until then, `curl` and `/docs` are the client.

---

## 5. Tests

```bash
cd capture-service
pip install -r requirements-dev.txt   # NOT requirements-whisper.txt
python -m pytest
```

535 tests, a few seconds, with **no GPU, no downloaded model, no Ollama and
no network**. That is enforced rather than intended:

- `requirements-dev.txt` does not install faster-whisper, so a top-level
  `import faster_whisper` anywhere in the request path fails CI with
  `ModuleNotFoundError`. `tests/test_transcribe.py` asserts
  `faster_whisper` is absent from `sys.modules` after building the app.
- Whisper is injected: `FasterWhisperTranscriber(settings, model_factory=…)`
  takes a factory, and `tests/conftest.py` passes a fake model that yields canned
  segments. `create_app(settings, transcriber, llm)` takes both backends as
  arguments, so no test monkeypatches a module global.
- Ollama is injected two ways: `OllamaClient(…, transport=httpx.MockTransport(…))`
  exercises the real client (payload shape, status handling, error translation)
  with no socket, and `FakeLlm` replaces the client entirely in endpoint tests.

What is covered:

| File | Covers |
| --- | --- |
| `tests/test_config.py` | every variable is read and lands in a `Settings` field; defaults; trimming; allowlists; URL root validation (including "no credential in a URL"); numeric ranges; NaN/infinite timeouts; immutable settings. |
| `tests/test_parse_cards.py` | the defensive parser: happy paths, id/timestamp minting, the `agentId` fallback chain, trimming, markdown fences (closed → unwrapped, unclosed → rejected), prose, truncated JSON, malformed JSON, `NaN`/`Infinity`, wrong envelope, renamed envelope, unknown fields, bad enums, every bad-field case, all-or-nothing batches, and "no error message or response quotes model output". |
| `tests/test_prompt.py` | `mm:ss` rendering, positional `c0…cN` chunk labels, context-before-transcript ordering, omission of absent spatial context. |
| `tests/test_transcribe.py` | segment → `TranscriptChunk` conversion, millisecond rounding, clamping, empty-segment dropping, merging bounds, prompt-budget enforcement, lazy model loading and caching, decoder/load failure translation, and the ML-free import guarantee. |
| `tests/test_ollama.py` | the request payload, `done_reason: "length"`, missing/invalid `message.content`, model-not-pulled vs. not-Ollama 404s, error statuses, non-JSON 200s, connect/timeout failures, bounded and newline-flattened log excerpts. |
| `tests/test_endpoints.py` | `/health`, `/capture`, `/transcribe`; the exact response envelope; client-side re-validation of our own response; the upload limit (both the declared-size fast path and the streaming counter) and that it stops before inference; request validation; every failure status and code; temp-file deletion; filename traversal; and "no transcript text in any response or log line". |
| `tests/test_extract_summarize.py` | `/extract` and `/summarize`: both envelopes, the extraction call staying schema-constrained while the summary call is not, grounded-field filtering on a JSON body, `componentReference` filtering, the refusal codes, shared-secret and CORS coverage, and the same "no transcript text in any response or log line" guarantee. |
| `tests/test_typescript_parity.py` | reads the TypeScript sources and fails on drift: the extraction prompt is byte-identical to `extractionPrompt.ts` and the minutes prompt to `lib/ai/summaryPrompt.ts`, the summary user-prompt layout and card-extras order match that builder, the key allowlists match `parseInsightCards.ts` **and** `types.ts`, the enums match both declarations, the parse-failure vocabulary matches, the transcript/context shapes match, and the shared limits and error codes match. |
| `tests/test_serve.py` | `python -m capture_service` binds the configured host/port, and an invalid environment stops the service with the variable named instead of a traceback. |

CI runs this in its own `capture-service` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), independent of the
Node jobs.

---

## 6. Layout

```
capture-service/
├── capture_service/
│   ├── main.py          FastAPI app: /health, /capture, /transcribe, /extract, /summarize, error handlers
│   ├── config.py        every environment variable, validated
│   ├── errors.py        the failure taxonomy (codes, statuses, transcript-free messages)
│   ├── schemas.py       the wire shapes shared with TypeScript
│   ├── transcribe.py    Transcriber protocol + the lazy faster-whisper backend
│   ├── ollama.py        LlmClient protocol + the Ollama HTTP client
│   ├── prompt.py        the extraction and minutes prompts (copies of the TypeScript ones)
│   ├── parse_cards.py   the defensive parser (a port of parseInsightCards.ts)
│   └── __main__.py      `python -m capture_service`
├── tests/               pytest suite + the fakes in conftest.py
├── requirements.txt              the HTTP service
├── requirements-dev.txt          + pytest (what CI installs)
├── requirements-whisper.txt      + faster-whisper (real transcription)
├── .env.example                  documented template
└── pytest.ini
```

Two files are **copies** of TypeScript originals — `prompt.py` (from
`extractionPrompt.ts` and `lib/ai/summaryPrompt.ts`) and `parse_cards.py` (from
`parseInsightCards.ts`) — because the two runtimes share no module format. The
TypeScript file is the authority in every case;
`tests/test_typescript_parity.py` fails the build until the copy is brought back
in line.

---

## 7. Not implemented here (and where it lives)

- **Live streaming, partial transcripts, PartyKit relay** — T4.7, after the
  batch path is proven.
- **Speaker diarization** — faster-whisper does not diarize, so batch mode emits
  one honest label (`speaker-1`) for the whole recording. Inventing speaker turns
  would put a fabricated name in `InsightCard.agentId` and the Manager workspace
  would display it as fact. WhisperX is the plan's candidate; it is an open
  question in `docs/local-capture-plan.md`.
- **Authentication** — the plan's §"Open questions" proposes a shared secret
  validated on every PartyKit → service request, and defers JWT. That is
  deployment work (T5.1); until it lands, bind this service to a private
  network and do not expose it to the internet.
- **CORS** — no `Access-Control-Allow-Origin` is sent. Whether the browser calls
  this service directly or through the nginx proxy in the docker-compose stack
  is a T4.4/T5.1 decision, and a wildcard origin on a service that accepts
  meeting audio would be the wrong default.
- **n8n mode** (`--use-n8n <webhook-url>`) — T4.8.
- **Postgres/Tracker writes** — the plan's optional persistence step; this
  service returns insights and stores nothing.
- **Docker packaging** — T5.1.

The uploaded recording is written to a temp file for the decoder and deleted
when the request ends, including on failure. No transcript, card or recording is
persisted.
