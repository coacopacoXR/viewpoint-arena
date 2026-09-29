# The Viewpoint Arena AI webhook

Point an AI job at your own service instead of ours.

In the admin console's **AI** section, choose **Your own service** for
Transcription, Cards or Meeting summary, give it a URL, and this is the contract
that URL has to satisfy. One URL can serve all three jobs — the `job` field says
which one arrived — and a service that implements only some of them can be
configured for just those.

The machine-readable half of this contract is
[`lib/ai/webhookContract.ts`](../../lib/ai/webhookContract.ts); the caller is
[`lib/ai/router.ts`](../../lib/ai/router.ts). This file is documentation of those
two, not a second source of truth.

## What we send

`POST` to your URL, from the server that runs this app — never from a browser.

- **Cards** and **Summary**: `Content-Type: application/json`, body as below.
- **Transcription**: `multipart/form-data` with one file part named `audio`.
- If you set a header name and value in the admin console, that header is sent on
  every request, unchanged. Nothing else is added: no `User-Agent` worth parsing,
  no signature, no correlation id.
- We accept `2xx` with a JSON body. Any other status is a failure, and your
  response body is logged on our server and **never** forwarded to a browser.
- We send `Accept: application/json`. A `200 text/html` — a login page, a proxy's
  error page, an SPA fallback — is reported to the administrator as
  `capture_endpoint_unavailable`, because that is what it is.
- A test request is at most 30 seconds. A real one has no ceiling of ours beyond
  the deployment's proxy timeouts (900 s for a whole-meeting recording).

## 1. Cards

A transcript window and the 3D context it was spoken in. Answer with insight
cards.

```http
POST /your-endpoint HTTP/1.1
Content-Type: application/json
Accept: application/json

{
  "job": "cards",
  "transcript": [
    { "speakerId": "speaker-1", "text": "The bracket weld will crack under load.", "startMs": 0, "endMs": 4200 },
    { "speakerId": "speaker-2", "text": "Then we re-run the simulation this week.", "startMs": 4200, "endMs": 8400 }
  ],
  "context": {
    "slide": {
      "agendaIdx": 2,
      "slideTitle": "Rear bracket",
      "hoveredPartName": "BRACKET_LH",
      "laserTargetPartName": "BRACKET_LH"
    },
    "components": [
      { "id": "node-14", "name": "BRACKET_LH", "path": "FRAME/BRACKET_LH" }
    ]
  }
}
```

`context.slide` and `context.components` are both optional; `hoveredPartName` and
`laserTargetPartName` are present only when somebody was pointing at something.
`components` is omitted entirely when the room had no model loaded.

Answer:

```json
{
  "cards": [
    {
      "type": "RISK",
      "title": "Bracket weld cracks under load",
      "description": "The reviewer said the weld will crack before the yield target.",
      "agentId": "speaker-1",
      "details": {
        "priority": "High",
        "impact": "Warranty returns",
        "componentReference": "node-14"
      }
    }
  ]
}
```

Rules, enforced by the same strict parser every other provider goes through:

- `type` is `RISK`, `RATIONALE` or `ACTION`. `details.priority` is `Critical`,
  `High`, `Medium` or `Low`, and it is **required**. `details.status`, if present,
  is `Open`, `In Review`, `Approved` or `Rejected`.
- Do not send `id` or `timestamp`; the app assigns both. Sending them is tolerated
  and they are kept, but omitting them is what we ask for.
- Do not add a field that is not part of the card. Unknown keys are rejected, not
  ignored — an envelope carrying `{"cards": […], "took": 4.2}` is refused.
- `details.componentReference` must be an `id` from `context.components`, or
  absent. A card naming a part that is not in the model is refused, because it
  sends a reviewer hunting for geometry that does not exist.
- `{"cards": []}` is a correct answer. So is refusing to invent one.

Per-type detail fields: `impact` and `mitigationStrategy` for `RISK`;
`designDriver`, `alternativesConsidered` and `tradeoffAnalysis` for `RATIONALE`;
`department`, `assignee` and `dueDate` (`YYYY-MM-DD`) for `ACTION`.
`componentReference` and `designStage` (`DETAILED_DESIGN`) apply to any type.

## 2. Meeting summary

The same transcript, plus the cards the app already extracted from it. Answer
with Markdown minutes.

```http
POST /your-endpoint HTTP/1.1
Content-Type: application/json

{
  "job": "summary",
  "transcript": [ …as above… ],
  "cards": [ …the app's own cards, with id and timestamp filled in… ],
  "title": "Rear bracket review"
}
```

`title` is present only when the review has a name. Either `transcript` or
`cards` may be empty — a curated review that was never recorded has cards and no
audio — but the app never sends both empty.

Answer:

```json
{ "summary": "## What was reviewed\n\nThe rear bracket…\n\n## Actions\n\n- [ ] Re-run the stress simulation — speaker-2\n" }
```

`summary` must be a non-empty string. An empty string is a failure, not a summary:
the administrator's **Test connection** has to be able to tell "it worked and said
nothing" from "it worked". Markdown is rendered as-is; there is no escaping or
sanitising pass between your answer and the reader, so send prose, not markup you
would not show a colleague.

## 3. Transcription

`multipart/form-data`, one file part named **`audio`**. It is whatever the browser
recorded — usually `audio/webm` (Opus), and up to 200 MiB for a whole meeting or
about 1 MiB for a live-transcript chunk. Sniff it; the filename is a hint
(`meeting.webm`, `chunk.webm`) and nothing more.

Answer with recognised spans. `start` and `end` are **seconds** from the start of
the recording, as numbers:

```json
{
  "segments": [
    { "start": 0.0, "end": 4.2, "text": "The bracket weld will crack under load." },
    { "start": 4.2, "end": 8.4, "text": "Then we re-run the simulation this week." }
  ]
}
```

- `{"segments": []}` is correct for silence, and is how a live-transcript chunk
  with no speech should be answered.
- A segment with empty or whitespace-only `text` is dropped, not an error.
- An `end` before its `start` is corrected rather than refused — inverted spans
  are a rounding artefact in most ASR stacks, and dropping the words to make a
  point about arithmetic would lose transcript.
- A string number (`"4.2"`) is accepted; plenty of gateways serialise floats that
  way.
- Extra fields on a segment are ignored. We have one speaker label for a whole
  recording and no diarization, so a `speaker` field is dropped rather than
  causing a refusal.

## Failures

Answer with a non-2xx status and we report the failure to the administrator using
our own vocabulary, not your text. The codes you will see in our admin console and
server log are `capture_upstream_error` (your status), `capture_upstream_timeout`,
`capture_upstream_unreachable` (nothing answered), `capture_endpoint_unavailable`
(a non-JSON 2xx) and `capture_parse_error` (a 2xx we could not use).

Nothing you send is echoed back to a browser. Not your status body, not your error
message, not the model's output. That is deliberate: the request contained a
transcript of a meeting about a design that has not shipped, and an error page
that quotes it is a leak — so we quote only our own codes, and the detail stays in
our server log.
