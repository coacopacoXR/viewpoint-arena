// POST /api/capture/local — a whole meeting recording in, InsightCards out.
//
// This handler used to be a byte-forwarding reverse proxy: read the raw stream,
// add the shared secret, hand it to capture-service's POST /capture, pass the
// answer back. It is now two router calls — transcription, then cards — because
// the deployment can choose a different AI for each of those jobs and a proxy
// cannot make a choice.
//
// What did NOT change, and what the browser relies on:
//   * the URL, the multipart shape and the `{ cards }` response;
//   * the 200 MB ceiling and the error codes that come with it;
//   * the shared secret, which is still added server-side from this container's
//     own environment and still never reaches the browser.
//
// What did change, and is worth knowing before you touch it:
//   * the body is parsed here instead of streamed, so the api container holds the
//     recording in memory. That is what a router costs: to choose a provider for
//     the AUDIO it has to have the audio. The ceiling is unchanged and
//     docker-compose gives `api` no memory limit of its own, so a 200 MB meeting
//     is the sizing case for that container now.
//   * a deployment that never opens the admin console's AI section resolves both
//     jobs to `builtin`, which is capture-service — so the default path is the
//     same two calls to the same service, just made from Node instead of nginx.
//
// SECURITY: the request body is someone's meeting. A failure is reported as a code
// from lib/ai/router.ts's closed vocabulary and nothing else — no stack, no
// upstream body, no message that could quote the recording. The one exception is
// deliberate: capture-service's OWN codes are forwarded verbatim, because they are
// ours, they carry no content, and the browser has a specific message for each.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SlideContext } from '../../lib/connectors/capture/types.ts';
import { runJob } from '../../lib/ai/router.ts';
import { recordingFilename } from '../../lib/connectors/capture/local.ts';
import {
  audioFromForm,
  DEFAULT_SLIDE_TITLE,
  enforceCaptureAccess,
  parseGroundedFromForm,
  parseMultipart,
  readCaptureBody,
  sendJobError,
} from './_request.ts';

/** Must stay at or above capture-service's CAPTURE_MAX_UPLOAD_BYTES default. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export const config = { api: { bodyParser: false } };

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Front-door password, when the deployment has one. Runs before the body is
  // read: an unadmitted request should not get as far as buffering a recording.
  if (!enforceCaptureAccess(req, res)) return;

  const raw = await readCaptureBody(req, res, MAX_UPLOAD_BYTES);
  if (raw === null) return;

  const form = await parseMultipart(raw, req.headers['content-type']);
  if (form === null) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const audio = audioFromForm(form);
  if (audio === null || audio.size === 0) {
    res.status(400).json({ error: 'empty_upload' });
    return;
  }

  const context = slideContextFromForm(form);
  const grounded = parseGroundedFromForm(form);
  if (grounded === null) {
    // Malformed grounded context is refused rather than dropped, exactly as the
    // JSON endpoints do: silently losing the component list is how a model starts
    // inventing component ids.
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const signal = requestSignal(req);

  try {
    // Job one: audio to transcript. Which provider does it is the router's answer,
    // not this handler's.
    const transcribed = await runJob(
      'transcription',
      {
        audio,
        // The browser's own mapping from a recorded MIME type to an honest file
        // extension, reused rather than copied: the upstream hands the name to
        // ffmpeg, which sniffs the real container, so a wrong extension is not
        // fatal — but two mappings would eventually disagree, and a log line
        // saying "meeting.webm" for an Ogg recording misleads whoever reads it.
        filename: recordingFilename(audio.type),
        contentType: audio.type || 'audio/webm',
        signal,
      },
    );
    if (transcribed.job !== 'transcription') {
      res.status(502).json({ error: 'capture_upstream_error' });
      return;
    }

    // Job two: transcript to cards. A second resolution on purpose rather than
    // reusing the first result — the two jobs can legitimately be different
    // providers, and that is the entire point of the batch.
    const extracted = await runJob('cards', {
      transcript: transcribed.transcript,
      context,
      grounded,
      signal,
    });
    if (extracted.job !== 'cards') {
      res.status(502).json({ error: 'capture_upstream_error' });
      return;
    }

    res.status(200).json({ cards: extracted.cards });
  } catch (err) {
    sendJobError(res, err, 'local');
  }
}

/**
 * The slide context from the form's optional fields.
 *
 * Never throws and never refuses the upload: a recording with no agenda context is
 * still worth extracting, and the labels fall back the same way the browser's own
 * meetingSlideContext and capture-service's SlideContext both do.
 */
function slideContextFromForm(form: FormData): SlideContext {
  const rawIdx = form.get('agendaIdx');
  const parsed = typeof rawIdx === 'string' ? Number.parseInt(rawIdx, 10) : NaN;
  const agendaIdx = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;

  const rawTitle = form.get('slideTitle');
  const slideTitle =
    typeof rawTitle === 'string' && rawTitle.trim() !== ''
      ? rawTitle.trim()
      : DEFAULT_SLIDE_TITLE;

  const context: SlideContext = { agendaIdx, slideTitle };
  const hovered = form.get('hoveredPartName');
  if (typeof hovered === 'string' && hovered.trim() !== '') {
    context.hoveredPartName = hovered.trim();
  }
  const laser = form.get('laserTargetPartName');
  if (typeof laser === 'string' && laser.trim() !== '') {
    context.laserTargetPartName = laser.trim();
  }
  return context;
}

function requestSignal(req: VercelRequest): AbortSignal | undefined {
  const candidate = (req as unknown as { signal?: unknown }).signal;
  return candidate instanceof AbortSignal ? candidate : undefined;
}

export default handler;
